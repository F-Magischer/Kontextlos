// End-to-end check: real server + 4 phone bots play a whole game.
//   npm test                     → phone-only room (one phone creates it, everything shows on phones)
//   GODOT=<godot_console.exe> npm test → the Godot big screen creates the room (headless smoke test)
//   SHOTS=<dir> as well          → Godot runs visibly at real speed and saves a screenshot every 2 s
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const WebSocket = require("ws");

const PORT = 8099;
const GODOT = process.env.GODOT;
const SHOTS = process.env.SHOTS;
const SLOW = SHOTS ? 3000 : 0; // give the screenshot run time to see lobby/vote/end
const ANSWERS = ["Ich lege mich einfach eine Stunde in die Badewanne", "Immer ein Löffel. Man weiß ja nie.", "Lauwarmer Tee und Stille", "Mit einem Glas und viel Geduld"];
const TWISTS = ["Bürgermeister tritt nach Skandal zurück", "Mein Hochzeitsvideo (Teil 3)", "Badewannen-Abo für Senioren", "wie entkomme ich einem Schwanensee"];
const kids = [];
const done = (code) => { kids.forEach((k) => k.kill()); process.exit(code); };
setTimeout(() => { console.error("FAIL: timeout"); done(1); }, SHOTS ? 600000 : 60000);

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, SPEED: SHOTS ? "1" : "20" } });
kids.push(server);
server.stderr.on("data", (d) => { console.error("[server] " + d); done(1); });
server.stdout.once("data", () => {
  if (!GODOT) return startBots(null);
  const args = ["--path", path.join(__dirname, "..", "..", "game"), ...(SHOTS ? [] : ["--headless"]), "--", `--server=ws://localhost:${PORT}`, ...(SHOTS ? [`--shots=${SHOTS}`] : [])];
  const host = spawn(GODOT, args);
  kids.push(host);
  const watch = (d) => {
    const s = String(d);
    if (/SCRIPT ERROR|Parse Error|Invalid access|Invalid call/.test(s)) { console.error("[godot] " + s); done(1); }
    const m = s.match(/ROOM (\w{4})/);
    if (m) startBots(m[1]);
  };
  host.stdout.on("data", watch);
  host.stderr.on("data", watch);
});

function startBots(hostCode) {
  const names = ["Ada", "Bo", "Cem", "Dana"];
  const results = {};
  const seen = new Set();
  let code = hostCode;
  const bot = (name, n) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const out = (d) => ws.send(JSON.stringify({ t: "msg", d }));
    ws.on("open", () => ws.send(JSON.stringify(code ? { t: "join", code, name } : { t: "create", name })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.t === "joined" && !code) {
        code = m.code; // first bot created the room; the others join it
        console.log("room", code, "(created on a phone)");
        names.slice(1).forEach((nm, i) => setTimeout(() => bot(nm, i + 1), (i + 1) * 100));
        // a duplicate name must be refused
        const dup = new WebSocket(`ws://localhost:${PORT}`);
        dup.on("open", () => dup.send(JSON.stringify({ t: "join", code, name: "ada" })));
        dup.on("message", (r) => { assert.equal(JSON.parse(r).t, "error"); seen.add("dup-refused"); dup.close(); });
      }
      if (m.t !== "msg") return;
      const d = m.d;
      seen.add(d.s);
      assert.equal(d.code, code, "every phone screen carries the room code");
      if (d.s === "lobby" && d.vip && d.count === names.length) setTimeout(() => out({ a: "start" }), SLOW);
      if (d.s === "write" && d.key[0] === "t") assert(d.post && d.post.answer && !d.post.prompt && !d.post.twist, "twist screen shows the post but not the question");
      if (d.s === "reveal") assert([1, 2, 3].includes(d.stage) && d.post.twist, "reveal stage");
      // Dana stays silent in round 1 so the timeout + fallback path runs too
      if (d.s === "write" && !(name === "Dana" && d.key === "a1" && !SLOW))
        out({ a: "submit", key: d.key, text: (d.key[0] === "a" ? ANSWERS : TWISTS)[(n + Number(d.key.slice(1))) % 4] });
      if (d.s === "vote") {
        assert(d.options.length >= 2, "vote needs at least 2 options");
        setTimeout(() => out({ a: "vote", key: d.key, i: d.options[0].i }), SLOW);
      }
      if (d.s === "end") {
        results[name] = d;
        if (Object.keys(results).length === names.length) {
          assert.deepEqual(Object.values(results).map((r) => r.place).sort(), [1, 2, 3, 4]);
          assert(Object.values(results).some((r) => parseInt(r.text) > 0), "someone scored");
          const need = ["lobby", "write", "vote", "wait", ...(hostCode ? [] : ["reveal", "scores", "dup-refused"])];
          for (const s of need) assert(seen.has(s), "missing " + s);
          console.log("PASS", hostCode ? "(Godot big screen)" : "(phones only)", Object.values(results).map((r) => r.text).join(", "));
          setTimeout(() => done(0), SLOW * 2);
        }
      }
    });
  };
  if (code) names.forEach((nm, i) => setTimeout(() => bot(nm, i), i * 100));
  else bot(names[0], 0);
}
