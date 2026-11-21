// End-to-end: party service + real KONTEXTLOS server. Two guests make a party, vote for KONTEXTLOS,
// get sent there, hand their one-time codes to the game and land in the same room, leader as VIP.
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { tally } = require("../vote");

// ---- vote rules
const V = (o) => new Map(Object.entries(o));
assert.deepStrictEqual(tally(["stay", "a", "b"], V({}), null).winner, "stay");
assert.deepStrictEqual(tally(["a", "b"], V({}), null).winner, null);
assert.deepStrictEqual(tally(["stay", "a", "b"], V({ x: "a", y: "a", z: "b" }), null).winner, "a");
assert.deepStrictEqual(tally(["stay", "a"], V({ x: "a", y: "stay" }), "a"), { winner: "stay", how: "tie-stay", counts: { stay: 1, a: 1 } });
assert.deepStrictEqual(tally(["a", "b"], V({ x: "a", y: "b" }), "b").winner, "b");
assert.deepStrictEqual(tally(["a", "b"], V({ x: "a", y: "b" }), null, () => 0).how, "lot");
assert.deepStrictEqual(tally(["a"], V({ x: "constructor" }), null).winner, null);

// ---- end to end
const KEY = "test-key";
const PP = 18090, GP = 18080;
const SELF = `http://localhost:${PP}`;
const env = { ...process.env, PARTY_API: SELF, PARTY_KEY: KEY, PLAY_URL: SELF, KONTEXTLOS_URL: `http://localhost:${GP}`, KONTEXTLOS_KEY: KEY, JASAGER_URL: "http://localhost:9", GRUENDERFIEBER_URL: "http://localhost:9" }; // other games that are down: never picked here
const procs = [
  spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...env, PORT: PP }, stdio: "inherit" }),
  spawn(process.execPath, [path.join(__dirname, "..", "..", "server", "server.js")], { env: { ...env, PORT: GP }, stdio: "inherit" }),
];
const done = (code) => { procs.forEach((p) => p.kill()); process.exit(code); };
setTimeout(() => { console.error("FAIL: timeout"); done(1); }, 20000);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a socket that collects messages and lets the test wait for one
function sock(url, headers) {
  const ws = new WebSocket(url, { headers });
  const got = [];
  ws.on("message", (d) => got.push(JSON.parse(d)));
  ws.next = async (pred) => { for (;;) { const i = got.findIndex(pred); if (i >= 0) return got.splice(i, 1)[0]; await wait(20); } };
  ws.say = (o) => ws.send(JSON.stringify(o));
  ws.closed = new Promise((r) => ws.on("close", (c) => r(c)));
  return new Promise((ok, no) => { ws.on("open", () => ok(ws)); ws.on("error", no); });
}

async function guest() {
  const r = await fetch(SELF + "/api/me");
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return sock(SELF.replace("http", "ws"), { origin: SELF, cookie });
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(SELF + "/health"); await fetch(`http://localhost:${GP}/`); break; } catch { await wait(100); } }

  // foreign page may not use the cookie
  const r = await fetch(SELF + "/api/me");
  const evil = new WebSocket(SELF.replace("http", "ws"), { headers: { origin: "https://evil.example", cookie: r.headers.get("set-cookie").split(";")[0] } });
  assert.strictEqual(await new Promise((ok) => evil.on("close", ok)), 4001);

  const anna = await guest(), ben = await guest();
  anna.say({ t: "name", name: "Anna" });
  ben.say({ t: "name", name: "Ben" });
  await anna.next((m) => m.t === "state" && m.me.name === "Anna");
  anna.say({ t: "create" });
  const code = (await anna.next((m) => m.t === "state" && m.party)).party.code;
  ben.say({ t: "join", code });
  await anna.next((m) => m.t === "state" && m.party?.members.length === 2);

  // only the leader may start a vote by default
  ben.say({ t: "vote-start" });
  assert.match((await ben.next((m) => m.t === "note")).msg, /Leader/);
  anna.say({ t: "vote-start" });
  const v = (await ben.next((m) => m.t === "state" && m.party?.vote)).party.vote;
  assert.deepStrictEqual(v.options, ["kontextlos", "jasager", "gruenderfieber"]);
  anna.say({ t: "vote", option: "kontextlos" });
  ben.say({ t: "vote", option: "kontextlos" }); // everyone voted: ends early, then hands over

  const goA = await anna.next((m) => m.t === "go"), goB = await ben.next((m) => m.t === "go");
  assert.strictEqual(goA.url, `http://localhost:${GP}`);
  assert.strictEqual(goB.url, goA.url);

  // on the game page the overlay asks for a code and passes it to the game
  anna.say({ t: "code" });
  ben.say({ t: "code" });
  const ca = (await anna.next((m) => m.t === "code")).code, cb = (await ben.next((m) => m.t === "code")).code;

  const game = `ws://localhost:${GP}`;
  const pa = await sock(game), pb = await sock(game);
  pb.say({ t: "join", party: cb });
  pa.say({ t: "join", party: ca });
  const ja = await pa.next((m) => m.t === "joined"), jb = await pb.next((m) => m.t === "joined");
  assert.strictEqual(ja.name, "Anna");
  assert.strictEqual(jb.name, "Ben");
  assert.strictEqual(ja.code, jb.code, "same room");
  // Ben arrived first, but Anna leads the party, so she is the game's VIP
  const lobby = await pa.next((m) => m.t === "msg" && m.d.s === "lobby" && m.d.players.length === 2 && m.d.vip);
  assert.strictEqual(lobby.d.vip, true);

  // a code works once
  const again = await sock(game);
  again.say({ t: "join", party: ca });
  assert.match((await again.next((m) => m.t === "error")).msg, /Party-Raum/);

  // reloading the game page: a fresh code puts Anna back into her own seat
  anna.say({ t: "code" });
  const ca2 = (await anna.next((m) => m.t === "code")).code;
  const pa2 = await sock(game);
  pa2.say({ t: "join", party: ca2 });
  assert.strictEqual((await pa2.next((m) => m.t === "joined")).id, ja.id);

  // a party member who joins later is sent straight to the game
  const cara = await guest();
  cara.say({ t: "name", name: "Cara" });
  await cara.next((m) => m.t === "state" && m.me.name === "Cara");
  cara.say({ t: "join", code });
  await cara.next((m) => m.t === "go");

  // the room's lobby shows the party code, its QR leads to the party invite, typed room codes are sent there too
  const lob = await pb.next((m) => m.t === "msg" && m.d.s === "lobby");
  assert.strictEqual(lob.d.party, code);
  assert.strictEqual(lob.d.link, `${SELF}/p/${code}`);
  const stranger = await sock(game);
  stranger.say({ t: "join", code: ja.code, name: "Zoe", dev: "x" });
  assert.strictEqual((await stranger.next((m) => m.t === "party")).url, `${SELF}/p/${code}`);
  assert.strictEqual((await fetch(`${SELF}/qr/${code}.png`)).headers.get("content-type"), "image/png");

  // kicked from the party: out of the game room and sent to the hub
  anna.say({ t: "kick", id: (await ben.next((m) => m.t === "state" && m.party)).me.id });
  assert.strictEqual((await ben.next((m) => m.t === "go")).url, SELF + "/");
  assert.match((await pb.next((m) => m.t === "error")).msg, /geworfen/);
  assert.strictEqual(await pb.closed, 1005);

  // unknown game key cannot redeem
  const bad = await fetch(SELF + "/api/redeem", { method: "POST", headers: { authorization: "Bearer nope" }, body: JSON.stringify({ code: "x" }) });
  assert.strictEqual(bad.status, 403);

  console.log("OK: party flow");
  done(0);
})().catch((e) => { console.error("FAIL:", e); done(1); });
