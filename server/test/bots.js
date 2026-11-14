// End-to-end check: real server + headless Godot host (--fast) + 4 phone bots play a whole game.
// Usage: GODOT=path/to/godot_console.exe npm test
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const WebSocket = require("ws");

const PORT = 8099;
const GODOT = process.env.GODOT || "godot";
const kids = [];
const SLOW = process.env.SHOTS ? 3000 : 0; // give the screenshot run time to see lobby/vote/end
const ANSWERS = ["Ich lege mich einfach eine Stunde in die Badewanne", "Immer ein Löffel. Man weiß ja nie.", "Lauwarmer Tee und Stille", "Mit einem Glas und viel Geduld"];
const TWISTS = ["Bürgermeister tritt nach Skandal zurück", "Mein Hochzeitsvideo (Teil 3)", "Badewannen-Abo für Senioren", "wie entkomme ich einem Schwanensee"];
const done = (code) => { kids.forEach((k) => k.kill()); process.exit(code); };
setTimeout(() => { console.error("FAIL: timeout"); done(1); }, process.env.SHOTS ? 400000 : 120000);

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT } });
kids.push(server);
server.stdout.once("data", () => {
  // SHOTS=<dir>: windowed, real speed, screenshots every 2 s (for art review)
  const mode = process.env.SHOTS ? ["--", `--server=ws://localhost:${PORT}`, `--shots=${process.env.SHOTS}`]
    : ["--headless", "--", `--server=ws://localhost:${PORT}`, "--fast", "--phone-mode"];
  const host = spawn(GODOT, ["--path", path.join(__dirname, "..", "..", "game"), ...mode]);
  kids.push(host);
  host.stderr.on("data", (d) => process.stderr.write("[godot] " + d));
  host.stdout.on("data", (d) => {
    const s = String(d);
    if (/SCRIPT ERROR|Parse Error/.test(s)) { console.error(s); done(1); }
    const m = s.match(/ROOM (\w{4})/);
    if (m) startBots(m[1]);
  });
});

function startBots(code) {
  console.log("room", code);
  const names = ["Ada", "Bo", "Cem", "Dana"];
  const results = {};
  const seen = new Set();
  names.forEach((name, n) => setTimeout(() => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const out = (d) => ws.send(JSON.stringify({ t: "msg", d }));
    // a duplicate name must be refused
    if (n === 1) {
      const dup = new WebSocket(`ws://localhost:${PORT}`);
      dup.on("open", () => dup.send(JSON.stringify({ t: "join", code, name: "ada" })));
      dup.on("message", (r) => { assert.equal(JSON.parse(r).t, "error"); seen.add("dup-refused"); dup.close(); });
    }
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.t !== "msg") return;
      const d = m.d;
      seen.add(d.s);
      if (d.s === "lobby" && d.vip && d.count === names.length) setTimeout(() => out({ a: "start" }), SLOW);
      if (d.s === "write" && d.key[0] === "t") assert(d.post && d.post.answer && !d.post.prompt && !d.post.twist, "twist screen must show the post but not the question");
      if (d.s === "reveal") assert([1, 2, 3].includes(d.stage) && d.post.twist, "reveal stage");
      // Dana stays silent in round 1 so the timeout + fallback path runs too
      if (d.s === "write" && !(name === "Dana" && d.key === "a1" && !SLOW)) out({ a: "submit", key: d.key, text: (d.key[0] === "a" ? ANSWERS : TWISTS)[(n + d.key.length + Number(d.key.slice(1))) % 4] });
      if (d.s === "vote") {
        assert(d.options.length >= 2, "vote needs at least 2 options");
        setTimeout(() => out({ a: "vote", key: d.key, i: d.options[0].i }), SLOW);
      }
      if (d.s === "end") {
        results[name] = d;
        if (Object.keys(results).length === names.length) {
          const places = Object.values(results).map((r) => r.place).sort();
          assert.deepEqual(places, [1, 2, 3, 4]);
          assert(Object.values(results).some((r) => parseInt(r.text) > 0), "someone scored");
          for (const s of ["lobby", "write", "vote", "wait", "reveal", "scores", "dup-refused"]) assert(seen.has(s), "missing " + s);
          console.log("PASS", results);
          setTimeout(() => done(0), SLOW * 2);
        }
      }
    });
  }, n * 150));
}
