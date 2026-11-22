// Three bots play a full round of GRÜNDERFIEBER: submit drawings, pitch, invest, results.
const assert = require("assert");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const WebSocket = require("ws");

// a real 1×1 white PNG, as a phone would send it
function png() {
  const crc = (b) => { let c, n = -1; for (const x of b) { c = (n ^ x) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; n = (n >>> 8) ^ c; } return (n ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const data = zlib.deflateSync(Buffer.from([0, 255, 255, 255]));
  return "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", data), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const PORT = 18060;
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, SPEED: "20", PARTY_KEY: "k" }, stdio: "inherit" });
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

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${PORT}/`); break; } catch { await wait(100); } }
  const a = await bot(), b = await bot(), c = await bot();
  a.say({ t: "create", name: "Anna", dev: "a" });
  const code = (await a.next((m) => m.t === "joined")).code;
  b.say({ t: "join", code, name: "Ben", dev: "b" });
  c.say({ t: "join", code, name: "Cem", dev: "c" });
  await a.next((m) => m.t === "state" && m.d.players.length === 3);
  a.act({ a: "rounds", value: 1 });
  a.act({ a: "start" });

  const dev = (await a.next((m) => m.t === "state" && m.d.phase === "develop")).d;
  assert.ok(dev.brief.what && dev.brief.who && dev.brief.problem);
  a.act({ a: "reroll" });
  const re = (await a.next((m) => m.t === "state" && m.d.rerolled)).d;
  assert.ok(re.brief.rerolled);

  a.act({ a: "submit", name: "Sockenradar", slogan: "Nie wieder allein", img: "data:image/png;base64,bm9wZQ==" }); // not a PNG: ignored
  a.act({ a: "submit", name: "Sockenradar", slogan: "Nie wieder allein", img: png() });
  b.act({ a: "submit", name: "Katzenwecker", slogan: "", img: png() });
  c.act({ a: "submit", name: "Gurkenöffner", slogan: "Endlich frei", img: png() });

  // all three handed in: pitches start right away
  let s = (await a.next((m) => m.t === "state" && m.d.phase === "pitch")).d;
  assert.strictEqual(s.pitch.count, 3);
  const img = await fetch(`http://localhost:${PORT}${s.pitch.img}`);
  assert.strictEqual(img.headers.get("content-type"), "image/png");

  // the boss may change settings mid-round: shown at once, used from the next round
  a.act({ a: "settings", pitch: 30 });
  s = (await a.next((m) => m.t === "state" && m.d.pitchSecs === 30)).d;
  assert.strictEqual(s.total, 60, "this round keeps its pitch time");
  b.act({ a: "settings", pitch: 90 }); // not the boss: ignored

  // everyone pitches first, investing comes after the last pitch
  const bots = { Anna: a, Ben: b, Cem: c };
  for (let i = 1; i <= 3; i++) {
    if (i > 1) s = (await a.next((m) => m.t === "state" && m.d.phase === "pitch" && m.d.pitch.index === i)).d;
    bots[s.pitch.name].act({ a: "done" });
  }
  const inv = (await a.next((m) => m.t === "state" && m.d.phase === "invest")).d;
  assert.strictEqual(inv.invest.products.length, 3);
  assert.ok(inv.invest.can && inv.pitchSecs === 30);
  const id = Object.fromEntries(inv.players.map((p) => [p.name, p.id]));
  a.act({ a: "invest", alloc: { [id.Anna]: 10 } }); // own product: ignored
  a.act({ a: "invest", alloc: { [id.Ben]: 33 } }); // not a multiple of 5: ignored
  a.act({ a: "invest", alloc: { [id.Ben]: 60, [id.Cem]: 50 } }); // over budget: ignored
  a.act({ a: "invest", alloc: { [id.Ben]: 60, [id.Cem]: 40 } });
  b.act({ a: "invest", alloc: { [id.Anna]: 100 } });
  c.act({ a: "invest", alloc: {} }); // keeps the money
  const res = (await a.next((m) => m.t === "state" && m.d.phase === "end")).d;
  assert.strictEqual(res.results.list.length, 3);
  const raised = { Anna: 100, Ben: 60, Cem: 40 };
  for (const p of res.players) assert.strictEqual(p.money, raised[p.name], p.name);
  a.act({ a: "restart" });
  await a.next((m) => m.t === "state" && m.d.phase === "lobby");

  // ---- Kettenbrief: every card passes three players (each sees the parts before), then someone else invents
  a.act({ a: "settings", mode: "kette" });
  a.act({ a: "start" });
  for (let step = 0; step < 3; step++) {
    for (const [w, x] of [[a, "A"], [b, "B"], [c, "C"]]) {
      const s = (await w.next((m) => m.t === "state" && m.d.phase === "write" && m.d.write.step === step && m.d.write.task && !m.d.write.done)).d;
      if (step) assert.ok(s.write.task.prev.what, "sees the part before");
      w.act({ a: "write", [s.write.task.fields[0]]: `${x}${step}` });
    }
  }
  const chain = (await a.next((m) => m.t === "state" && m.d.phase === "develop" && m.d.brief?.by)).d.brief;
  assert.strictEqual(new Set([chain.what[0], chain.who[0], chain.problem[0]]).size, 3, "three different authors");
  assert.strictEqual(chain.by.length, 3);

  // ---- Auftrag: one client writes the brief for everyone else, then only invests
  const k = await bot(), l = await bot(), m2 = await bot();
  k.say({ t: "create", name: "Kim", dev: "k" });
  const code2 = (await k.next((m) => m.t === "joined")).code;
  l.say({ t: "join", code: code2, name: "Lea", dev: "l" });
  m2.say({ t: "join", code: code2, name: "Max", dev: "m" });
  await k.next((m) => m.t === "state" && m.d.players.length === 3);
  k.act({ a: "settings", mode: "auftrag" });
  k.act({ a: "start" });
  const kw = (await k.next((m) => m.t === "state" && m.d.phase === "write")).d;
  assert.deepStrictEqual(kw.write.task.fields, ["what", "who", "problem"]);
  k.act({ a: "write", what: "Ein Hut", who: "für Geister", problem: "" }); // empty: a random card fills it
  const lb = (await l.next((m) => m.t === "state" && m.d.phase === "develop")).d;
  assert.strictEqual(lb.brief.what, "Ein Hut");
  assert.ok(lb.brief.problem);
  assert.deepStrictEqual(lb.brief.by, ["Kim"]);
  const kd = (await k.next((m) => m.t === "state" && m.d.phase === "develop")).d;
  assert.ok(kd.setter && !kd.playing && kd.budget === 100, "the client only invests");

  // ---- Problem: everyone writes only a problem, the next player invents the rest
  const p = [await bot(), await bot(), await bot()];
  p[0].say({ t: "create", name: "Pia", dev: "p0" });
  const code3 = (await p[0].next((m) => m.t === "joined")).code;
  p[1].say({ t: "join", code: code3, name: "Paul", dev: "p1" });
  p[2].say({ t: "join", code: code3, name: "Pit", dev: "p2" });
  await p[0].next((m) => m.t === "state" && m.d.players.length === 3);
  p[0].act({ a: "settings", mode: "problem" });
  p[0].act({ a: "start" });
  for (const [i, w] of p.entries()) {
    const s = (await w.next((m) => m.t === "state" && m.d.phase === "write" && m.d.write.task && !m.d.write.done)).d;
    assert.deepStrictEqual(s.write.task.fields, ["problem"]);
    w.act({ a: "write", problem: `Problem ${i}` });
  }
  for (const [i, w] of p.entries()) {
    const b = (await w.next((m) => m.t === "state" && m.d.phase === "develop")).d.brief;
    assert.ok(!b.what && !b.who, "only a problem");
    assert.match(b.problem, /^Problem \d$/);
    assert.notStrictEqual(b.problem, `Problem ${i}`, "someone else's problem");
    assert.strictEqual(b.by.length, 1);
  }

  console.log("PASS gruenderfieber: briefs, drawings, pitches, investments, results, chain and client modes");
  done(0);
})().catch((e) => { console.error("FAIL:", e); done(1); });
