// Kick / ban / unban against a real server.
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const WebSocket = require("ws");
const PORT = 8098;
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT } });
const fail = (m) => { console.error("FAIL", m); server.kill(); process.exit(1); };
setTimeout(() => fail("timeout"), 15000);
const conn = (msg, onMsg) => { const w = new WebSocket(`ws://localhost:${PORT}`); w.on("open", () => w.send(JSON.stringify(msg))); w.on("message", (r) => onMsg(JSON.parse(r), w)); return w; };
server.stdout.once("data", () => {
  let code, steps = [];
  const boss = conn({ t: "create", name: "Boss", dev: "dev-boss" }, (m, w) => {
    if (m.t === "joined") { code = m.code; conn({ t: "join", code, name: "Troll", dev: "dev-troll" }, troll); }
    if (m.t !== "msg" || m.d.s !== "lobby") return;
    const d = m.d, t = d.players.find((p) => p.name === "Troll");
    if (t && !steps.includes("kick")) { steps.push("kick"); w.send(JSON.stringify({ t: "msg", d: { a: "kick", id: t.id } })); }
    else if (t && steps.includes("rejoined") && !steps.includes("ban")) { steps.push("ban"); w.send(JSON.stringify({ t: "msg", d: { a: "ban", id: t.id } })); }
    else if (!t && d.banned.length && !steps.includes("tryagain")) {
      steps.push("tryagain");
      assert.equal(d.banned[0].name, "Troll");
      // same device with a new name must stay out
      conn({ t: "join", code, name: "Neuer Name", dev: "dev-troll" }, (r) => {
        assert.equal(r.t, "error"); steps.push("blocked");
        w.send(JSON.stringify({ t: "msg", d: { a: "unban", dev: d.banned[0].dev } }));
      });
    } else if (steps.includes("blocked") && !d.banned.length && !steps.includes("unbanned")) {
      steps.push("unbanned");
      conn({ t: "join", code, name: "Troll", dev: "dev-troll" }, (r) => { if (r.t === "joined") { console.log("PASS kick/ban/unban"); server.kill(); process.exit(0); } });
    }
  });
  function troll(m) {
    if (m.t === "error" && /geworfen/.test(m.msg) && !steps.includes("rejoined")) {
      steps.push("rejoined"); // a kicked player may come back (new join), only a ban keeps them out
      conn({ t: "join", code, name: "Troll", dev: "dev-troll" }, () => {});
    }
  }
});
