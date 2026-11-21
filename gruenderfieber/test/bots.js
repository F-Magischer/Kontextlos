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

  const bots = { Anna: a, Ben: b, Cem: c };
  const raised = {};
  for (let i = 1; i <= 3; i++) {
    if (i > 1) s = (await a.next((m) => m.t === "state" && m.d.phase === "pitch" && m.d.pitch.index === i && m.d.stage === "talk")).d;
    const pres = s.pitch.name;
    bots[pres].act({ a: "done" });
    await a.next((m) => m.t === "state" && m.d.stage === "invest" && m.d.pitch.index === i);
    const others = Object.keys(bots).filter((n) => n !== pres);
    bots[others[0]].act({ a: "invest", amount: 33 }); // not a multiple of 5: ignored
    bots[others[0]].act({ a: "invest", amount: 30 });
    bots[others[1]].act({ a: "invest", amount: 0 });
    raised[pres] = 30;
  }
  const res = (await a.next((m) => m.t === "state" && m.d.phase === "end")).d;
  assert.strictEqual(res.results.list.length, 3);
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

  console.log("PASS gruenderfieber: briefs, drawings, pitches, investments, results, chain and client modes");
  done(0);
})().catch((e) => { console.error("FAIL:", e); done(1); });
