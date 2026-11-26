// ECHT ODER GTA? server: rooms, game rules (game.js), the pictures (pics.js), the page (solo and rooms), QR codes and the FURIDA party hookup.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const G = require("./game");
const S = require("./stats");
const P = require("./pics");

const PORT = Number(process.env.PORT) || 8050;
// changes on every deploy; open pages compare it and reload so they never run old code against a new server
const BUILD = process.env.RENDER_GIT_COMMIT || String(Date.now());
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml" };

// FURIDA party service: it asks us for a room, players arrive with a one-time code we redeem there
const PARTY_API = (process.env.PARTY_API || "https://play.furida.workers.dev").replace(/\/$/, "");
const PARTY_KEY = process.env.PARTY_KEY;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const partyAuth = (h) => !!PARTY_KEY && crypto.timingSafeEqual(sha(h), sha("Bearer " + PARTY_KEY));

async function redeem(code) {
  if (!PARTY_KEY) return null;
  try {
    const r = await fetch(PARTY_API + "/api/redeem", {
      method: "POST", headers: { authorization: "Bearer " + PARTY_KEY, "content-type": "application/json" },
      body: JSON.stringify({ code }), signal: AbortSignal.timeout(10000),
    });
    return r.ok ? await r.json() : null;
  } catch (e) { console.error("party redeem:", e.message); return null; }
}

function readJson(req) {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(b) || {}); } catch { ok({}); } });
    req.on("error", () => ok({}));
  });
}

function publicUrl() {
  const pub = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (pub) return pub.replace(/\/$/, "");
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === "IPv4" && !a.internal) return `http://${a.address}:${PORT}`;
  return `http://localhost:${PORT}`;
}

const rooms = new Map();
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words
function newRoom() {
  let c;
  do c = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join(""); while (rooms.has(c));
  const r = G.createRoom(c, publicUrl());
  rooms.set(c, r);
  return r;
}
// a room nobody is connected to anymore disappears after a while
function maybeCleanup(r) {
  clearTimeout(r.cleanup);
  if ([...r.players.values()].some((p) => p.online)) return;
  r.cleanup = setTimeout(() => { G.stop(r); rooms.delete(r.code); }, 10 * 60 * 1000);
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return res.writeHead(400).end(); }
  if (p === "/health") return res.writeHead(200, { "Cache-Control": "no-store" }).end("ok"); // the party service waits for this while we wake up
  if (p.startsWith("/party/") && req.method === "POST") {
    if (!partyAuth(req.headers.authorization || "")) return res.writeHead(403).end();
    return readJson(req).then((b) => {
      if (p === "/party/prepare") {
        const r = newRoom();
        // party rooms: QR codes and links lead to the party invite, so newcomers join the party first
        if (/^https?:\/\/[^\s"<>]+$/.test(b.invite || "")) { r.invite = b.invite; r.party = String(b.code || "").slice(0, 8); }
        if (typeof b.leader === "string") r.lead = "party:" + b.leader.slice(0, 40); // the party leader is the boss here too
        maybeCleanup(r);
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ room: r.code }));
      }
      if (p === "/party/kick") { // removed from the party: also out of the game room
        const r = rooms.get(String(b.room || ""));
        const hit = r && [...r.players].find(([, q]) => q.dev === "party:" + String(b.player || ""));
        if (hit) G.kick(r, hit[0]);
        return res.writeHead(204).end();
      }
      res.writeHead(404).end();
    });
  }
  // solo mode: the page plays on its own with the whole picture list
  if (p === "/api/pics") {
    const list = (k) => P.list(k).map((x) => ({ src: x.src, credit: x.credit, link: x.link, where: x.where }));
    return res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=600" }).end(JSON.stringify({ gta: list("gta"), real: list("real") }));
  }
  // a finished solo game, for the play data: which pictures fooled people
  if (p === "/api/solo" && req.method === "POST") {
    return readJson(req).then((b) => {
      const answers = Array.isArray(b.answers) ? b.answers.slice(0, 20).filter((a) => a && P.known(a.src) && typeof a.right === "boolean").map((a) => ({ src: a.src, kind: P.GTA.some((g) => g.src === a.src) ? "gta" : "real", right: a.right })) : [];
      if (["eins", "mehrere"].includes(b.mode) && answers.length) S.log("solo", null, String(b.dev || "").slice(0, 40), { mode: b.mode, right: answers.filter((a) => a.right).length, total: answers.length, answers });
      res.writeHead(204).end();
    });
  }
  const qr = p.match(/^\/qr\/([A-Z]{4})\.png$/);
  if (qr) {
    return QRCode.toBuffer(rooms.get(qr[1])?.invite || `${publicUrl()}/?code=${qr[1]}`, { type: "png", margin: 1, scale: 10, color: { dark: "#1A0B2E", light: "#FFFFFF" } })
      .then((png) => res.writeHead(200, { "Content-Type": "image/png" }).end(png))
      .catch(() => res.writeHead(500).end());
  }
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" }).end(data);
  });
});

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const rid = () => crypto.randomBytes(5).toString("hex");
const nameTaken = (r, n) => [...r.players.values()].some((q) => q.name.toLowerCase() === n.toLowerCase());

// players online right now, once a minute (for the "online" and peak numbers)
setInterval(() => {
  let players = 0, n = 0;
  for (const r of rooms.values()) { const k = [...r.players.values()].filter((p) => p.online).length; if (k) { n++; players += k; } }
  if (players) S.log("ccu", null, null, { players, rooms: n });
}, 60 * 1000).unref();

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on("connection", (ws) => {
  let room = null, pid = null;

  const joinAs = (r, name, dev) => {
    pid = rid(); room = r;
    clearTimeout(r.cleanup);
    send(ws, { t: "joined", build: BUILD, id: pid, code: r.code, name });
    G.addPlayer(r, pid, name, ws, dev);
  };
  const rejoinAs = (r, id, old) => {
    if (old.ws && old.ws !== ws) old.ws.close();
    pid = id; room = r;
    clearTimeout(r.cleanup);
    send(ws, { t: "joined", build: BUILD, id, code: r.code, name: old.name });
    G.rejoin(r, id, ws);
  };
  const partyJoin = async (code) => {
    const p = await redeem(code);
    if (room) return;
    const r = p && rooms.get(p.room);
    if (!r) return send(ws, { t: "error", msg: "Der Party-Raum ist nicht mehr da." });
    const dev = "party:" + p.id;
    const old = [...r.players].find(([, q]) => q.dev === dev);
    if (old && old[1].kicked) return send(ws, { t: "error", msg: "Du wurdest aus dem Raum geworfen." });
    if (old) return rejoinAs(r, old[0], old[1]);
    if (r.players.size >= G.MAX_PLAYERS) return send(ws, { t: "error", msg: "Raum ist voll." });
    let name = String(p.name || "Gast").slice(0, 12);
    for (let i = 2; nameTaken(r, name); i++) name = String(p.name).slice(0, 11) + i;
    joinAs(r, name, dev);
  };

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;
    if (!room && m.t === "join" && typeof m.party === "string") return void partyJoin(m.party.slice(0, 64)).catch(console.error);
    if (!room && (m.t === "join" || m.t === "create")) {
      const name = String(m.name || "").replace(/\s+/g, " ").trim().slice(0, 12);
      const dev = String(m.dev || "").slice(0, 40);
      if (!name) return send(ws, { t: "error", msg: "Bitte gib einen Namen ein." });
      if (m.t === "create") return joinAs(newRoom(), name, dev);
      const r = rooms.get(String(m.code || "").toUpperCase().trim());
      if (!r) return send(ws, { t: "error", msg: "Raum nicht gefunden." });
      const old = typeof m.pid === "string" && r.players.get(m.pid);
      if (old && old.kicked) return send(ws, { t: "error", msg: "Du wurdest aus dem Raum geworfen." });
      if (old) return rejoinAs(r, m.pid, old);
      if (r.invite) return send(ws, { t: "party", url: r.invite }); // a party plays here: join the party first
      if (nameTaken(r, name)) return send(ws, { t: "error", msg: "Name ist schon vergeben." });
      if (r.players.size >= G.MAX_PLAYERS) return send(ws, { t: "error", msg: "Raum ist voll." });
      return joinAs(r, name, dev);
    }
    if (room && m.t === "msg") return G.onPlayer(room, pid, m.d);
  });

  ws.on("close", () => {
    if (!room) return;
    const p = room.players.get(pid);
    if (p && p.ws === ws) { p.ws = null; G.leave(room, pid); }
    maybeCleanup(room);
  });
});

// drop pictures that stopped loading (their sites may move them), at start and twice a day
if (process.env.PICS_CHECK !== "0") { P.check().catch(console.error); setInterval(() => P.check().catch(console.error), 12 * 3600 * 1000).unref(); }

server.listen(PORT, () => console.log(`ECHT ODER GTA? server on ${publicUrl()}`));
