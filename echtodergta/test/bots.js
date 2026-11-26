// Bots play ECHT ODER GTA? in both modes: hidden answers while asking, scoring, early reveal, the end; plus the solo API.
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const P = require("../pics");

const PORT = 18050;
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, SPEED: "20", PICS_CHECK: "0" }, stdio: "inherit" });
const done = (code) => { srv.kill(); process.exit(code); };
setTimeout(() => { console.error("FAIL: timeout"); done(1); }, 30000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bot() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const got = [];
  ws.on("message", (d) => got.push(JSON.parse(d)));
  ws.next = async (pred) => { for (;;) { const i = got.findIndex(pred); if (i >= 0) return got.splice(i, 1)[0]; await wait(10); } };
  ws.say = (o) => ws.send(JSON.stringify(o));
  ws.act = (d) => ws.say({ t: "msg", d });
  return new Promise((ok, no) => { ws.on("open", () => ok(ws)); ws.on("error", no); });
}
const kindOf = (src) => (P.GTA.some((g) => g.src === src) ? "gta" : "real");

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${PORT}/health`); break; } catch { await wait(100); } }
  const pics = await (await fetch(`http://localhost:${PORT}/api/pics`)).json();
  assert.ok(pics.gta.length >= 20 && pics.real.length >= 20, "picture lists");

  const a = await bot(), b = await bot();
  a.say({ t: "create", name: "Anna", dev: "a" });
  const code = (await a.next((m) => m.t === "joined")).code;
  b.say({ t: "join", code, name: "Ben", dev: "b" });
  await a.next((m) => m.t === "state" && m.d.players.length === 2);
  b.act({ a: "settings", rounds: 5 }); // not the boss: ignored
  a.act({ a: "settings", rounds: 5, mode: "eins" });
  await a.next((m) => m.t === "state" && m.d.rounds === 5);
  a.act({ a: "start" });

  // mode "eins": Anna always right, Ben always wrong
  for (let round = 1; round <= 5; round++) {
    const s = (await a.next((m) => m.t === "state" && m.d.phase === "ask" && m.d.round === round)).d;
    assert.strictEqual(s.q.pics.length, 1);
    assert.strictEqual(s.q.answer, undefined, "no answer while asking");
    assert.strictEqual(s.q.pics[0].kind, undefined, "no kind while asking");
    const truth = kindOf(s.q.pics[0].src);
    a.act({ a: "answer", pick: "maybe" }); // invalid: ignored
    a.act({ a: "answer", pick: truth });
    b.act({ a: "answer", pick: truth === "gta" ? "real" : "gta" }); // both answered: reveal at once
    const r = (await a.next((m) => m.t === "state" && m.d.phase === "reveal" && m.d.round === round)).d;
    assert.strictEqual(r.q.answer, truth);
    assert.ok(r.q.pics[0].credit, "credit shown after the answer");
    const me = r.result.picks[r.you];
    assert.ok(me.right && me.gain >= 100 && me.gain <= 150);
    assert.strictEqual(Object.values(r.result.picks).filter((x) => !x.right).length, 1);
    a.act({ a: "next" });
  }
  const e = (await a.next((m) => m.t === "state" && m.d.phase === "end")).d;
  const score = Object.fromEntries(e.players.map((p) => [p.name, p.score]));
  assert.ok(score.Anna >= 500 && score.Ben === 0, JSON.stringify(score));
  assert.strictEqual(e.players.find((p) => p.name === "Anna").streak, 5);

  // mode "mehrere": four pictures, exactly one from GTA
  a.act({ a: "restart" });
  await a.next((m) => m.t === "state" && m.d.phase === "lobby");
  a.act({ a: "settings", mode: "mehrere", rounds: 5 });
  a.act({ a: "start" });
  const s = (await a.next((m) => m.t === "state" && m.d.phase === "ask" && m.d.mode === "mehrere")).d;
  assert.strictEqual(s.q.pics.length, 4);
  const kinds = s.q.pics.map((p) => kindOf(p.src));
  assert.strictEqual(kinds.filter((k) => k === "gta").length, 1, "one GTA picture");
  a.act({ a: "answer", pick: kinds.indexOf("gta") });
  b.act({ a: "answer", pick: 9 }); // out of range: ignored, Ben runs out of time
  const r = (await a.next((m) => m.t === "state" && m.d.phase === "reveal")).d;
  assert.strictEqual(r.q.answer, kinds.indexOf("gta"));
  assert.ok(r.result.picks[r.you].right);
  assert.strictEqual(Object.values(r.result.picks).find((x) => !x.right).pick, null, "Ben gave no answer");

  // solo results: only known pictures count
  const solo = await fetch(`http://localhost:${PORT}/api/solo`, { method: "POST", body: JSON.stringify({ mode: "eins", answers: [{ src: pics.gta[0].src, right: true }, { src: "https://evil.example/x.jpg", right: true }] }) });
  assert.strictEqual(solo.status, 204);

  console.log("PASS echtodergta: both modes, hidden answers, scoring, end, solo api");
  done(0);
})().catch((e) => { console.error("FAIL:", e); done(1); });
