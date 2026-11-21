// Three bots play a full game of JA-SAGER; checks scoring, early reveal, late joiners and party auth.
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { points, tolerance } = require("../game");

// ---- scoring rules
assert.strictEqual(points(3, 3, 5), 3);
assert.strictEqual(points(2, 3, 5), 1);
assert.strictEqual(points(4, 3, 5), 1);
assert.strictEqual(points(1, 3, 5), 0);
assert.strictEqual(points(null, 3, 5), 0);
assert.strictEqual(tolerance(9), 1);
assert.strictEqual(tolerance(10), 2);
assert.strictEqual(points(1, 3, 12), 1); // 2 off still counts from 10 players
assert.strictEqual(tolerance(20), 3);

const PORT = 18070;
const URL = `ws://localhost:${PORT}`;
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, SPEED: "20", PARTY_KEY: "k" }, stdio: "inherit" });
const done = (code) => { srv.kill(); process.exit(code); };
setTimeout(() => { console.error("FAIL: timeout"); done(1); }, 30000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bot() {
  const ws = new WebSocket(URL);
  const got = [];
  ws.on("message", (d) => got.push(JSON.parse(d)));
  ws.next = async (pred) => { for (;;) { const i = got.findIndex(pred); if (i >= 0) return got.splice(i, 1)[0]; await wait(10); } };
  ws.say = (o) => ws.send(JSON.stringify(o));
  ws.act = (d) => ws.say({ t: "msg", d });
  return new Promise((ok, no) => { ws.on("open", () => ok(ws)); ws.on("error", no); });
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${PORT}/`); break; } catch { await wait(100); } }
  assert.strictEqual((await fetch(`http://localhost:${PORT}/party/prepare`, { method: "POST" })).status, 403);

  const a = await bot(), b = await bot(), c = await bot();
  a.say({ t: "create", name: "Anna", dev: "a" });
  const code = (await a.next((m) => m.t === "joined")).code;
  b.say({ t: "join", code, name: "Ben", dev: "b" });
  c.say({ t: "join", code, name: "anna", dev: "c" });
  assert.match((await c.next((m) => m.t === "error")).msg, /vergeben/);
  c.say({ t: "join", code, name: "Cem", dev: "c" });
  await c.next((m) => m.t === "joined");
  await a.next((m) => m.t === "state" && m.d.players.length === 3);

  a.act({ a: "rounds", value: 5 });
  a.act({ a: "start" });
  const s = await a.next((m) => m.t === "state" && m.d.phase === "ask");
  assert.strictEqual(s.d.n, 3);
  assert.ok(s.d.q.endsWith("?"));

  // Anna and Ben say yes, Cem no: the real count is 2
  b.act({ a: "answer", answer: true, guess: 4 }); // out of range: ignored
  a.act({ a: "answer", answer: true, guess: 2 });
  b.act({ a: "answer", answer: true, guess: 1 });
  c.act({ a: "answer", answer: false, guess: 0 });
  const r = (await a.next((m) => m.t === "state" && m.d.phase === "reveal")).d; // all locked in: no waiting for the timer
  assert.strictEqual(r.result.yes.length, 2);
  assert.strictEqual(r.result.no.length, 1);
  const score = (name) => r.players.find((p) => p.name === name).score;
  assert.deepStrictEqual([score("Anna"), score("Ben"), score("Cem")], [3, 1, 0]);

  // nobody answers the rest: the timer moves the game on to the end
  const end = (await a.next((m) => m.t === "state" && m.d.phase === "end")).d;
  assert.strictEqual(end.round, 5);
  a.act({ a: "restart" });
  await a.next((m) => m.t === "state" && m.d.phase === "lobby");

  console.log("PASS ja-sager: scoring, early reveal, full game");
  done(0);
})().catch((e) => { console.error("FAIL:", e); done(1); });
