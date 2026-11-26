// FURIDA party service: guest identity (HttpOnly cookie), parties, game votes, hand-over codes for games.
// Also serves the hub (/, /p/CODE) and the in-game overlay (/overlay) from the same page.
// All state lives in memory: parties are short-lived. See docs/party-system-konzept.md.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const GAMES = require("./games");
const { tally } = require("./vote");
const S = require("./stats");

const PORT = Number(process.env.PORT) || 8090;
const SELF = (process.env.PLAY_URL || "https://play.furida.workers.dev").replace(/\/$/, "");
const SECURE = SELF.startsWith("https:");
const COOKIE = SECURE ? "__Host-fid" : "fid"; // __Host- needs https; it stops other subdomains from planting the cookie
const PUBLIC = path.join(__dirname, "public");
const SEC = 1000, MIN = 60 * SEC;
const T = { code: MIN, voterGrace: 15 * SEC, leaderGrace: MIN, memberGone: 10 * MIN, playerGone: 24 * 60 * MIN, prepare: MIN, down: 5 * MIN, cooldown: MIN, wake: 3 * MIN, poll: 3 * SEC };
const MAX_MEMBERS = 20;
const VOTE_SECS = [20, 30, 60];
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png" };
const HEAD = {
  "Cache-Control": "no-cache",
  // the overlay is framed by game pages that use COEP (Godot needs it), so it must opt in too
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-site",
  "Content-Security-Policy": `frame-ancestors 'self' ${GAMES.map((g) => new URL(g.url).origin).join(" ")}`,
  "X-Content-Type-Options": "nosniff",
};

const players = new Map(); // id -> player
const bySecret = new Map(); // sha256(cookie secret) -> player
const parties = new Map(); // join code -> party
const codes = new Map(); // hand-over code -> { player, game, room, exp }
const down = new Map(); // game id -> unavailable until

const hash = (s) => crypto.createHash("sha256").update(s).digest();
const devOf = (pl) => pl.hash.slice(0, 16);
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const safeEq = (a, b) => crypto.timingSafeEqual(hash(String(a)), hash(String(b)));
const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
const game = (id) => GAMES.find((g) => g.id === id);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const online = (p) => p.sockets.size > 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// a game server answers its /health with "ok" once it is awake (free hosts sleep and take ~30–60 s to start)
const up = (g) => fetch(g.api + "/health", { signal: AbortSignal.timeout(5 * SEC) }).then(async (r) => r.ok && (await r.text()).trim() === "ok").catch(() => false);

// ---------------------------------------------------------------- identity
function secretOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie || "");
  return m && m[1];
}
function playerFor(secret) {
  const h = hash(secret).toString("hex");
  let p = bySecret.get(h);
  if (!p) {
    p = { id: rnd(8), name: "", party: null, sockets: new Set(), offlineAt: Date.now(), tries: [], hash: h };
    bySecret.set(h, p);
    players.set(p.id, p);
  }
  return p;
}

// ---------------------------------------------------------------- party state
function view(pl) {
  const pa = parties.get(pl.party);
  const now = Date.now();
  return {
    t: "state",
    me: { id: pl.id, name: pl.name },
    games: GAMES.map((g) => ({ id: g.id, name: g.name, tag: g.tag, desc: g.desc, players: g.players, time: g.time, tags: g.tags, art: g.art, url: g.url, server: g.api, max: g.max, down: (down.get(g.id) || 0) > now })),
    party: pa && {
      code: pa.code, leader: pa.leader, anyone: pa.anyone, secs: pa.secs, busy: pa.busy, last: pa.last,
      wake: pa.wake ? Math.round((now - pa.wake) / SEC) : null, // seconds the game server has been starting up
      game: pa.game && pa.game.id,
      members: pa.members.map((id) => { const m = players.get(id); return { id, name: m.name, online: online(m) }; }),
      vote: pa.vote && { options: pa.vote.options, counts: tally(pa.vote.options, pa.vote.votes).counts, mine: pa.vote.votes.get(pl.id) || null, left: Math.max(0, pa.vote.ends - now) },
    },
  };
}
const push = (pl) => pl.sockets.forEach((ws) => send(ws, view(pl)));
const broadcast = (pa) => pa.members.forEach((id) => push(players.get(id)));
const tell = (pa, msg) => pa.members.forEach((id) => players.get(id).sockets.forEach((ws) => send(ws, { t: "note", msg })));
const go = (pl, id) => pl.sockets.forEach((ws) => send(ws, { t: "go", url: game(id).url }));
const taken = (pa, name, self) => pa.members.some((id) => id !== self && players.get(id).name.toLowerCase() === name.toLowerCase());

function newParty(leader) {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join(""); while (parties.has(code));
  const pa = { code, leader: leader.id, members: [leader.id], game: null, vote: null, busy: null, wake: null, last: null, anyone: false, secs: 30, cool: 0, banned: new Set() };
  parties.set(code, pa);
  S.log("party_create", code, devOf(leader));
  leader.party = code;
  return pa;
}

function removeMember(pa, pl) {
  pa.members = pa.members.filter((id) => id !== pl.id);
  pl.party = null;
  push(pl);
  if (!pa.members.length) { if (pa.vote) clearTimeout(pa.vote.timer); parties.delete(pa.code); return; }
  if (pa.leader === pl.id) pa.leader = pa.members.find((id) => online(players.get(id))) || pa.members[0];
  if (pa.vote) { pa.vote.votes.delete(pl.id); if (checkVote(pa)) return; }
  broadcast(pa);
}

// ---------------------------------------------------------------- voting
function startVote(pa, pl, ws) {
  if (pa.vote || pa.busy) return;
  if (pa.leader !== pl.id) {
    if (!pa.anyone) return send(ws, { t: "note", msg: "Nur der Party-Leader kann eine Abstimmung starten." });
    if (Date.now() < pa.cool) return send(ws, { t: "note", msg: "Gerade erst abgestimmt – kurz warten." });
  }
  const n = pa.members.length, now = Date.now();
  const options = GAMES.filter((g) => n <= g.max && !((down.get(g.id) || 0) > now)).map((g) => g.id);
  if (pa.game) options.unshift("stay");
  if (!options.length) return send(ws, { t: "note", msg: "Gerade passt kein Spiel zu eurer Gruppe." });
  pa.vote = { options, votes: new Map(), ends: now + pa.secs * SEC, timer: setTimeout(() => endVote(pa), pa.secs * SEC) };
  pa.last = null;
  // wake sleeping free-tier game servers while people vote
  for (const g of GAMES) up(g);
  broadcast(pa);
}

// ends the vote early once every active voter has voted; returns true if it ended
function checkVote(pa) {
  const v = pa.vote;
  if (!v) return false;
  const now = Date.now();
  const voters = pa.members.map((id) => players.get(id)).filter((m) => online(m) || now - m.offlineAt < T.voterGrace);
  if (voters.length && voters.every((m) => v.votes.has(m.id))) { endVote(pa); return true; }
  return false;
}

function endVote(pa) {
  const v = pa.vote;
  if (!v || !parties.has(pa.code)) return;
  clearTimeout(v.timer);
  pa.vote = null;
  const r = tally(v.options, v.votes, v.votes.get(pa.leader));
  pa.last = { winner: r.winner, how: r.how };
  S.log("vote", pa.code, null, { options: v.options, counts: r.counts, winner: r.winner, how: r.how, members: pa.members.length });
  if (!r.winner || r.winner === "stay") { pa.cool = Date.now() + T.cooldown; return broadcast(pa); }
  transition(pa, r.winner, true);
}

// ---------------------------------------------------------------- hand-over to a game
async function transition(pa, id, byVote = false) {
  const g = game(id);
  pa.busy = id;
  broadcast(pa);
  // a sleeping server: wake it and let everyone watch it start (progress bar) instead of giving up
  let started = null; // the server was asleep: when we started waking it
  if (!(await up(g))) {
    pa.wake = started = Date.now();
    broadcast(pa);
    while (parties.has(pa.code) && Date.now() - pa.wake < T.wake && !(await up(g))) await wait(T.poll);
    pa.wake = null;
  }
  let room = null;
  try {
    const r = await fetch(g.api + "/party/prepare", {
      method: "POST", headers: { authorization: "Bearer " + g.key, "content-type": "application/json" }, body: JSON.stringify({ code: pa.code, invite: `${SELF}/p/${pa.code}`, leader: pa.leader }), signal: AbortSignal.timeout(T.prepare),
    });
    room = r.ok ? String((await r.json()).room || "") : "";
    if (!room) throw new Error("prepare answered " + r.status);
  } catch (e) {
    console.error(`[${g.id}] ${e.message}`);
    down.set(id, Date.now() + T.down);
    pa.busy = null;
    if (!parties.has(pa.code)) return;
    broadcast(pa);
    return tell(pa, `${g.name} ließ sich gerade nicht starten. Ihr bleibt, wo ihr seid. Tipp: In der Bibliothek bei ${g.name} „Server öffnen“ antippen, kurz warten, dann nochmal.`);
  }
  pa.busy = null;
  if (!parties.has(pa.code)) return;
  pa.game = { id, room };
  S.log("play", pa.code, null, { game: id, members: pa.members.length, vote: byVote, woke: !!started });
  broadcast(pa);
  pa.members.forEach((m) => go(players.get(m), id));
}

function onMsg(pl, ws, m) {
  let pa = parties.get(pl.party);
  const lead = pa && pa.leader === pl.id;
  switch (m.t) {
    case "name": {
      const n = clean(m.name);
      if (!n) return send(ws, { t: "note", msg: "Bitte gib einen Namen ein." });
      if (pa && taken(pa, n, pl.id)) return send(ws, { t: "note", msg: "Den Namen gibt es in der Party schon." });
      pl.name = n;
      return pa ? broadcast(pa) : push(pl);
    }
    case "create":
      if (!pl.name) return;
      if (pa) removeMember(pa, pl);
      return broadcast(newParty(pl));
    case "join": {
      const now = Date.now();
      pl.tries = pl.tries.filter((t) => now - t < MIN);
      if (pl.tries.push(now) > 10) return send(ws, { t: "note", msg: "Zu viele Versuche. Warte kurz." });
      const t = parties.get(String(m.code || "").toUpperCase().trim());
      if (!pl.name) return;
      if (!t) return send(ws, { t: "note", msg: "Party nicht gefunden." });
      if (t === pa) { push(pl); if (t.game && !t.busy) go(pl, t.game.id); return; } // own invite link: back into the running game
      if (t.banned.has(pl.id)) return send(ws, { t: "note", msg: "Du wurdest aus dieser Party entfernt." });
      if (t.members.length >= MAX_MEMBERS) return send(ws, { t: "note", msg: "Die Party ist voll." });
      if (taken(t, pl.name, pl.id)) return send(ws, { t: "note", msg: "Den Namen gibt es in der Party schon – ändere ihn." });
      if (pa) removeMember(pa, pl);
      t.members.push(pl.id);
      pl.party = t.code;
      S.log("party_join", t.code, devOf(pl), { members: t.members.length, playing: t.game?.id || null });
      broadcast(t);
      if (t.game && !t.busy) go(pl, t.game.id); // the party already plays: follow it
      return;
    }
    case "leave":
      return pa && removeMember(pa, pl);
  }
  if (!pa) return;
  switch (m.t) {
    case "kick": {
      const k = players.get(String(m.id));
      if (!lead || !k || k === pl || !pa.members.includes(k.id)) return;
      pa.banned.add(k.id);
      removeMember(pa, k);
      if (pa.game) { // out of the game room too, so they cannot keep playing
        const g = game(pa.game.id);
        fetch(g.api + "/party/kick", { method: "POST", headers: { authorization: "Bearer " + g.key, "content-type": "application/json" },
          body: JSON.stringify({ room: pa.game.room, player: k.id }), signal: AbortSignal.timeout(T.prepare) }).catch((e) => console.error(`[${g.id}] kick: ${e.message}`));
      }
      return k.sockets.forEach((s) => { send(s, { t: "note", msg: "Du wurdest aus der Party entfernt." }); send(s, { t: "go", url: SELF + "/" }); });
    }
    case "settings":
      if (!lead || pa.vote) return;
      pa.anyone = !!m.anyone;
      if (VOTE_SECS.includes(m.secs)) pa.secs = m.secs;
      return broadcast(pa);
    case "pick":
      if (lead && !pa.vote && !pa.busy && game(m.game) && pa.members.length <= game(m.game).max) transition(pa, m.game);
      return;
    case "vote-start":
      return startVote(pa, pl, ws);
    case "vote":
      if (!pa.vote || !pa.vote.options.includes(m.option)) return;
      pa.vote.votes.set(pl.id, m.option);
      if (!checkVote(pa)) broadcast(pa);
      return;
    case "vote-cancel":
      if (!lead || !pa.vote) return;
      clearTimeout(pa.vote.timer);
      pa.vote = null;
      return broadcast(pa);
    case "code": {
      if (!pa.game || pa.busy) return;
      const code = rnd(16);
      codes.set(code, { player: pl.id, game: pa.game.id, room: pa.game.room, exp: Date.now() + T.code });
      return send(ws, { t: "code", code, game: pa.game.id });
    }
  }
}

// ---------------------------------------------------------------- housekeeping
setInterval(() => {
  const now = Date.now();
  for (const pa of [...parties.values()]) {
    for (const id of [...pa.members]) { const m = players.get(id); if (!online(m) && now - m.offlineAt > T.memberGone && parties.has(pa.code)) removeMember(pa, m); }
    if (!parties.has(pa.code)) continue;
    const L = players.get(pa.leader);
    if (!online(L) && now - L.offlineAt > T.leaderGrace) {
      const next = pa.members.find((id) => online(players.get(id)));
      if (next) { pa.leader = next; broadcast(pa); }
    }
    checkVote(pa);
  }
  for (const [c, v] of codes) if (v.exp < now) codes.delete(c);
  for (const p of [...players.values()]) if (!p.party && !online(p) && now - p.offlineAt > T.playerGone) { players.delete(p.id); bySecret.delete(p.hash); }
}, 5 * SEC).unref();

// people on the site right now (open sockets) and parties with someone online
function live() {
  const on = [...players.values()].filter(online);
  return { players: on.length, parties: [...parties.values()].filter((pa) => pa.members.some((id) => online(players.get(id)))).length };
}
setInterval(() => { const l = live(); if (l.players) S.log("ccu", null, null, l); }, MIN).unref();

// ---------------------------------------------------------------- http
const json = (res, code, o, head = {}) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...head }).end(JSON.stringify(o));

function readJson(req) {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(b)); } catch { ok({}); } });
    req.on("error", () => ok({}));
  });
}

// a game backend exchanges a one-time code for who the player is and which room to put them in
async function redeem(req, res) {
  const auth = req.headers.authorization || "";
  const body = await readJson(req);
  const c = codes.get(String(body.code));
  // the code names its game; only that game's key may redeem it (works even if two games share a key)
  const g = c && game(c.game);
  if (!c || !g || !g.key || !safeEq(auth, "Bearer " + g.key) || c.exp < Date.now()) return json(res, 403, { error: "invalid" });
  codes.delete(String(body.code));
  const pl = players.get(c.player);
  if (!pl) return json(res, 403, { error: "invalid" });
  const pa = parties.get(pl.party);
  return json(res, 200, { id: pl.id, name: pl.name, room: c.room, leader: !!pa && pa.leader === pl.id });
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return res.writeHead(400).end(); }
  if (p === "/health") return res.writeHead(200).end("ok");
  if (p === "/api/me") {
    let s = secretOf(req), head = {};
    if (!s) {
      s = rnd(32);
      head["Set-Cookie"] = `${COOKIE}=${s}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${SECURE ? "; Secure" : ""}`;
    }
    const pl = playerFor(s);
    return json(res, 200, { id: pl.id, name: pl.name }, head);
  }
  const qr = p.match(/^\/qr\/([A-Z]{4})\.png$/);
  if (qr) {
    return QRCode.toBuffer(`${SELF}/p/${qr[1]}`, { type: "png", margin: 1, scale: 10, color: { dark: "#1B1A17", light: "#FFFDF7" } })
      .then((png) => res.writeHead(200, { ...HEAD, "Content-Type": "image/png" }).end(png))
      .catch(() => res.writeHead(500).end());
  }
  if (p === "/data") return S.page(req, res, live(), GAMES).catch((e) => { console.error(e); res.writeHead(500).end("Fehler: " + e.message); });
  if (p === "/api/redeem" && req.method === "POST") return redeem(req, res).catch((e) => { console.error(e); json(res, 500, {}); });
  const f = p === "/" || p === "/overlay" || /^\/p\/[A-Za-z]{4}$/.test(p) ? "index.html" : p.slice(1);
  const file = path.normalize(path.join(PUBLIC, f));
  if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { ...HEAD, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on("connection", (ws, req) => {
  const s = secretOf(req);
  // the cookie rides along with any same-site request, so only our own pages may open a socket
  if (req.headers.origin !== SELF || !s) return ws.close(4001, "auth");
  const pl = playerFor(s);
  pl.sockets.add(ws);
  const today = new Date().toISOString().slice(0, 10);
  if (pl.seen !== today) { pl.seen = today; S.log("visit", null, devOf(pl)); } // once a day per device
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && typeof m.t === "string") try { onMsg(pl, ws, m); } catch (e) { console.error(e); }
  });
  ws.on("close", () => {
    pl.sockets.delete(ws);
    if (online(pl)) return;
    pl.offlineAt = Date.now();
    const pa = parties.get(pl.party);
    if (pa) broadcast(pa);
  });
  const pa = parties.get(pl.party);
  if (pa) broadcast(pa); else push(pl);
});

server.listen(PORT, () => console.log(`FURIDA party service on :${PORT} (public ${SELF})`));
