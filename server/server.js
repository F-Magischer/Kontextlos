// KONTEXTLOS server: rooms, game logic (game.js), phone controller and the Godot web build.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const G = require("./game");

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, "public");
const MAX_MSG = 4096;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".pck": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function lanUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === "IPv4" && !a.internal) return `http://${a.address}:${PORT}`;
  return `http://localhost:${PORT}`;
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const qr = p.match(/^\/qr\/([A-Z]{4})\.png$/);
  if (qr) {
    QRCode.toBuffer(`${lanUrl()}/?code=${qr[1]}`, { type: "png", margin: 1, scale: 10, color: { dark: "#1B1A17", light: "#FFFDF7" } })
      .then((png) => res.writeHead(200, { "Content-Type": "image/png", "Cross-Origin-Resource-Policy": "same-origin" }).end(png))
      .catch(() => res.writeHead(500).end());
    return;
  }
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

const rooms = new Map();
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words

function newRoom() {
  let c;
  do { c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join(""); } while (rooms.has(c));
  const r = G.createRoom(c, lanUrl());
  rooms.set(c, r);
  return r;
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const rid = () => Math.random().toString(36).slice(2, 10);

// a room nobody is connected to anymore disappears after a while
function maybeCleanup(r) {
  clearTimeout(r.cleanup);
  if (r.host || [...r.players.values()].some((p) => p.online)) return;
  r.cleanup = setTimeout(() => { r.timers.forEach(clearTimeout); rooms.delete(r.code); }, 10 * 60 * 1000);
}

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });
wss.on("connection", (ws) => {
  let room = null, role = null, pid = null;

  const joinAs = (r, name) => {
    pid = rid();
    room = r; role = "player";
    send(ws, { t: "joined", id: pid, code: r.code, name });
    G.addPlayer(r, pid, name, ws);
  };

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (!role && m.t === "host") {
      const existing = typeof m.code === "string" && rooms.get(m.code);
      room = existing && !existing.host ? existing : newRoom();
      room.host = ws; role = "host";
      clearTimeout(room.cleanup);
      send(ws, { t: "room", code: room.code, url: room.link });
      if (room.phase === "lobby") G.pushLobby(room);
      G.view(room);
      return;
    }

    if (!role && (m.t === "join" || m.t === "create")) {
      const name = String(m.name || "").trim().slice(0, 12);
      if (!name) return send(ws, { t: "error", msg: "Bitte gib einen Namen ein." });
      if (m.t === "create") {
        const r = newRoom();
        r.phoneMode = true; // no big screen: everything shows on the phones
        return joinAs(r, name);
      }
      const r = rooms.get(String(m.code || "").toUpperCase().trim());
      if (!r) return send(ws, { t: "error", msg: "Raum nicht gefunden." });
      const old = typeof m.pid === "string" && r.players.get(m.pid);
      if (old) {
        if (old.ws && old.ws !== ws) old.ws.close();
        pid = m.pid; room = r; role = "player";
        clearTimeout(r.cleanup);
        send(ws, { t: "joined", id: pid, code: r.code, name: old.name });
        G.rejoin(r, pid, ws);
        return;
      }
      for (const p of r.players.values())
        if (p.name.toLowerCase() === name.toLowerCase()) return send(ws, { t: "error", msg: "Name ist schon vergeben." });
      if (r.players.size >= G.MAX_PLAYERS) return send(ws, { t: "error", msg: "Raum ist voll." });
      clearTimeout(r.cleanup);
      return joinAs(r, name);
    }

    if (role === "player" && m.t === "msg") return G.onPlayer(room, pid, m.d);
    if (role === "host" && m.t === "mode" && room.phase === "lobby") return G.setMode(room, m.phone);
    if (role === "host" && m.t === "origin" && room.phase === "lobby") return G.setOrigin(room, m.on);
  });

  ws.on("close", () => {
    if (!room) return;
    if (role === "player") {
      const p = room.players.get(pid);
      if (p && p.ws === ws) { p.ws = null; G.leave(room, pid); }
    } else if (role === "host" && room.host === ws) {
      room.host = null; // the game keeps running; a reloaded screen reclaims the room
      if (room.phase === "lobby") G.pushLobby(room);
    }
    maybeCleanup(room);
  });
});

server.listen(PORT, () => console.log(`KONTEXTLOS server on ${lanUrl()}  (big screen: /host/  phones: /)`));
