// ECHT ODER GTA? rules. Every round shows pictures from Florida: real photos or GTA VI screenshots.
// Mode "eins": one picture, is it real or GTA? Mode "mehrere": four pictures, exactly one is from GTA, which one?
// Right answers score 100 plus up to 50 for speed. Whoever has the most points after all rounds wins.
const P = require("./pics");
const S = require("./stats");

const SPEED = Number(process.env.SPEED) || 1; // tests run faster
const MIN_PLAYERS = 1, MAX_PLAYERS = 20;
const ROUND_CHOICES = [5, 10, 15];
const MODES = ["eins", "mehrere"];
const TILES = 4; // pictures in mode "mehrere"
const T = { eins: 15, mehrere: 20, reveal: 9 }; // seconds
const COLORS = ["#FF4FA3", "#2EE6D6", "#FF9F45", "#B57BFF", "#FFE45C", "#4F8BFF", "#FF6B6B", "#7CF29C", "#F368E0", "#00B8D9",
  "#FFB36B", "#9D7BFF", "#5CE1E6", "#FF7AC6", "#C3F73A", "#FF5E5B", "#45D6A6", "#E0A3FF", "#FFC75F", "#6BCBFF"];

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const online = (r) => r.order.filter((id) => r.players.get(id).online);
// boss: the party leader while online, otherwise whoever joined first
const vip = (r) => online(r).find((id) => r.lead && r.players.get(id).dev === r.lead) || online(r)[0] || "";
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function createRoom(code, link) {
  return { code, link, invite: null, party: null, players: new Map(), order: [], phase: "lobby", rounds: 10, mode: "eins", round: 0,
    q: null, inRound: [], answers: new Map(), deadline: 0, started: 0, result: null, used: new Set(), timer: null, cleanup: null };
}

// a picture of this kind nobody in the room has seen yet (starts over when all are used)
function draw(r, kind) {
  let pool = P.list(kind).filter((p) => !r.used.has(p.src));
  if (!pool.length) { P.list(kind).forEach((p) => r.used.delete(p.src)); pool = P.list(kind); }
  const p = pool[Math.floor(Math.random() * pool.length)];
  r.used.add(p.src);
  return p;
}
function question(r) {
  if (r.mode === "eins") { const p = draw(r, Math.random() < 0.5 ? "gta" : "real"); return { mode: "eins", pics: [p], answer: p.kind }; }
  const pics = shuffle([draw(r, "gta"), ...Array.from({ length: TILES - 1 }, () => draw(r, "real"))]);
  return { mode: "mehrere", pics, answer: pics.findIndex((p) => p.kind === "gta") };
}
const ok = (q, pick) => pick === q.answer;

// one snapshot per player; while asking, the pictures go out without what they are
function view(r, id) {
  const q = r.q, open = r.phase === "reveal" || r.phase === "end";
  return {
    phase: r.phase, code: r.code, party: r.party, link: r.invite || `${r.link}/?code=${r.code}`,
    rounds: r.rounds, roundChoices: ROUND_CHOICES, mode: r.mode, round: r.round, min: MIN_PLAYERS, max: MAX_PLAYERS, total: T[r.mode],
    you: id, vip: id === vip(r), left: Math.max(0, r.deadline - Date.now()),
    q: q && { mode: q.mode, pics: q.pics.map((p) => (open ? { src: p.src, kind: p.kind, credit: p.credit, link: p.link, where: p.where } : { src: p.src })), answer: open ? q.answer : undefined },
    mine: r.answers.has(id) ? r.answers.get(id).pick : null, playing: r.inRound.includes(id), result: r.result,
    players: r.order.map((pid) => { const p = r.players.get(pid);
      return { id: pid, name: p.name, color: p.color, score: p.score, streak: p.streak, online: p.online, vip: pid === vip(r), done: r.answers.has(pid) }; }),
  };
}
const push = (r) => r.order.forEach((id) => send(r.players.get(id).ws, { t: "state", d: view(r, id) }));

function addPlayer(r, id, name, ws, dev) {
  r.players.set(id, { name, ws, dev, color: COLORS[r.order.length % COLORS.length], score: 0, streak: 0, online: true });
  r.order.push(id);
  S.log("join", r.code, dev, { name, phase: r.phase });
  push(r);
}
function rejoin(r, id, ws) { const p = r.players.get(id); p.ws = ws; p.online = true; push(r); }
function leave(r, id) { r.players.get(id).online = false; push(r); checkAll(r); }

function kick(r, id) {
  const p = r.players.get(id);
  if (!p) return;
  const ws = p.ws;
  p.ws = null; p.online = false; p.kicked = true;
  send(ws, { t: "error", msg: "Du wurdest aus dem Raum geworfen." });
  if (ws) ws.close();
  if (r.phase === "lobby") { r.players.delete(id); r.order.splice(r.order.indexOf(id), 1); }
  push(r);
  checkAll(r);
}

function later(r, sec, f) { clearTimeout(r.timer); r.timer = setTimeout(f, (sec * 1000) / SPEED); r.deadline = Date.now() + (sec * 1000) / SPEED; }

function startRound(r) {
  r.round++;
  r.inRound = online(r);
  r.q = question(r);
  r.answers = new Map();
  r.result = null;
  r.phase = "ask";
  r.started = Date.now();
  later(r, T[r.mode], () => reveal(r));
  push(r);
}

// everyone still here has answered: no need to wait for the timer
function checkAll(r) {
  if (r.phase !== "ask") return;
  if (r.inRound.filter((id) => r.players.get(id).online).every((id) => r.answers.has(id))) reveal(r);
}

function reveal(r) {
  if (r.phase !== "ask") return;
  const q = r.q, span = (T[r.mode] * 1000) / SPEED, picks = {};
  for (const id of r.inRound) {
    const a = r.answers.get(id), p = r.players.get(id);
    const right = !!a && ok(q, a.pick);
    const gain = right ? 100 + Math.round(50 * Math.max(0, 1 - (a.at - r.started) / span)) : 0;
    p.score += gain;
    p.streak = right ? p.streak + 1 : 0;
    picks[id] = { pick: a ? a.pick : null, right, gain };
  }
  r.result = { picks };
  const answered = [...r.answers.values()];
  S.log("question", r.code, null, { mode: q.mode, round: r.round, players: r.inRound.length, answered: answered.length,
    right: answered.filter((a) => ok(q, a.pick)).length, pics: q.pics.map((p) => ({ src: p.src, kind: p.kind })),
    picks: answered.map((a) => a.pick) });
  r.phase = "reveal";
  later(r, T.reveal, () => next(r));
  push(r);
}

function next(r) {
  if (r.phase !== "reveal") return;
  if (r.round >= r.rounds || online(r).length < MIN_PLAYERS) {
    r.phase = "end"; r.deadline = 0; clearTimeout(r.timer);
    S.log("game_end", r.code, null, { players: online(r).length, rounds: r.round, mode: r.mode });
    return push(r);
  }
  startRound(r);
}

function onPlayer(r, id, d) {
  if (!d || typeof d !== "object") return;
  const boss = id === vip(r);
  if (d.a === "start" && boss && r.phase === "lobby" && online(r).length >= MIN_PLAYERS) {
    r.round = 0;
    r.order.forEach((pid) => { const p = r.players.get(pid); p.score = 0; p.streak = 0; });
    S.log("game_start", r.code, null, { players: online(r).length, rounds: r.rounds, mode: r.mode, party: !!r.party });
    startRound(r);
  } else if (d.a === "settings" && boss && r.phase === "lobby") {
    if (ROUND_CHOICES.includes(d.rounds)) r.rounds = d.rounds;
    if (MODES.includes(d.mode)) r.mode = d.mode;
    push(r);
  } else if (d.a === "answer" && r.phase === "ask" && r.inRound.includes(id) && !r.answers.has(id)) {
    const valid = r.q.mode === "eins" ? d.pick === "gta" || d.pick === "real" : Number.isInteger(d.pick) && d.pick >= 0 && d.pick < r.q.pics.length;
    if (!valid) return;
    r.answers.set(id, { pick: d.pick, at: Date.now() });
    push(r);
    checkAll(r);
  } else if (d.a === "next" && boss && r.phase === "reveal") {
    next(r);
  } else if (d.a === "restart" && boss && r.phase === "end") {
    r.phase = "lobby"; r.round = 0; r.result = null; r.q = null; r.inRound = []; push(r);
  } else if (d.a === "kick" && boss && d.id !== id) {
    kick(r, String(d.id));
  }
}

const stop = (r) => clearTimeout(r.timer);

module.exports = { createRoom, addPlayer, rejoin, leave, kick, onPlayer, push, stop, MAX_PLAYERS, TILES };
