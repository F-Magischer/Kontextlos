// Room relay: the Godot host owns all game logic; this only routes messages and serves files.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, "public");
const MAX_PLAYERS = 8;
const MAX_MSG = 4096;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".pck": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function lanUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === "IPv4" && !a.internal) return `http://${a.address}:${PORT}`;
  return `http://localhost:${PORT}`;
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

const rooms = new Map(); // code -> { host, players: Map(id -> {name, ws}), timer }
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words

function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join(""); } while (rooms.has(c));
  return c;
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const rid = () => Math.random().toString(36).slice(2, 10);

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });
wss.on("connection", (ws) => {
  let room = null, role = null, pid = null;

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (!role && m.t === "host") {
      const existing = typeof m.code === "string" && rooms.get(m.code);
      if (existing && !existing.host) { room = existing; clearTimeout(room.timer); }
      else { room = { code: newCode(), host: null, players: new Map() }; rooms.set(room.code, room); }
      room.host = ws; role = "host";
      send(ws, { t: "room", code: room.code, url: lanUrl() });
      return;
    }

    if (!role && m.t === "join") {
      const code = String(m.code || "").toUpperCase().trim();
      const name = String(m.name || "").trim().slice(0, 12);
      const r = rooms.get(code);
      if (!r || !r.host) return send(ws, { t: "error", msg: "Raum nicht gefunden." });
      if (!name) return send(ws, { t: "error", msg: "Bitte gib einen Namen ein." });
      const old = typeof m.pid === "string" && r.players.get(m.pid);
      if (old) {
        if (old.ws && old.ws !== ws) old.ws.close();
        old.ws = ws; pid = m.pid;
        send(r.host, { t: "rejoin", id: pid });
      } else {
        for (const p of r.players.values())
          if (p.name.toLowerCase() === name.toLowerCase()) return send(ws, { t: "error", msg: "Name ist schon vergeben." });
        if (r.players.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "Raum ist voll." });
        pid = rid();
        r.players.set(pid, { name, ws });
        send(r.host, { t: "join", id: pid, name });
      }
      room = r; role = "player";
      send(ws, { t: "joined", id: pid, code, name: r.players.get(pid).name });
      return;
    }

    if (role === "player" && m.t === "msg") return send(room.host, { t: "msg", id: pid, d: m.d });
    if (role === "host" && m.t === "to") return send(room.players.get(m.id)?.ws, { t: "msg", d: m.d });
    if (role === "host" && m.t === "all") { for (const p of room.players.values()) send(p.ws, { t: "msg", d: m.d }); return; }
    if (role === "host" && m.t === "kick") {
      const p = room.players.get(m.id);
      if (p) { send(p.ws, { t: "error", msg: m.msg || "Du wurdest entfernt." }); p.ws?.close(); room.players.delete(m.id); }
    }
  });

  ws.on("close", () => {
    if (!room) return;
    if (role === "player") {
      const p = room.players.get(pid);
      if (p && p.ws === ws) { p.ws = null; send(room.host, { t: "leave", id: pid }); }
    } else if (role === "host" && room.host === ws) {
      room.host = null;
      for (const p of room.players.values()) send(p.ws, { t: "hostgone" });
      // keep room briefly so a reloaded host can reclaim it
      room.timer = setTimeout(() => rooms.delete(room.code), 5 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => console.log(`KONTEXTLOS server on ${lanUrl()}  (host: /host/  phones: /)`));
