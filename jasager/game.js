// JA-SAGER rules. Everyone sees the same question, answers yes/no for themselves and guesses how many
// of the round's players say yes (0 … all). Exact guess: 3 points, close: 1 point (closeness grows with the group).
const QUESTIONS = require("./questions");

const SPEED = Number(process.env.SPEED) || 1; // tests run faster
const MIN_PLAYERS = 2, MAX_PLAYERS = 20;
const ROUND_CHOICES = [5, 8, 12];
const T = { ask: 45, reveal: 15 }; // seconds
const COLORS = ["#18B26B", "#3D7BFF", "#F2545B", "#FF9F1C", "#8E5CF5", "#00A6A6", "#E84393", "#6AB04C",
  "#2D3A8C", "#C0392B", "#16A085", "#D35400", "#7D5BA6", "#0984E3", "#B33771", "#4B7F52", "#E1B12C", "#596275", "#FC427B", "#3B3B98"];

// within this many of the real count still scores 1 point: 1 up to 9 players, 2 from 10, 3 at 20
const tolerance = (n) => 1 + Math.floor(n / 10);
function points(guess, actual, n) {
  if (!Number.isInteger(guess)) return 0;
  const d = Math.abs(guess - actual);
  return d === 0 ? 3 : d <= tolerance(n) ? 1 : 0;
}

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const online = (r) => r.order.filter((id) => r.players.get(id).online);
const vip = (r) => online(r)[0] || "";

function createRoom(code, link) {
  return { code, link, invite: null, party: null, players: new Map(), order: [], phase: "lobby", rounds: 8, round: 0,
    q: "", inRound: [], answers: new Map(), deadline: 0, result: null, used: new Set(), timer: null, cleanup: null };
}

// one snapshot per player: everyone sees the same, plus their own answer
function view(r, id) {
  const n = r.inRound.length;
  return {
    phase: r.phase, code: r.code, party: r.party, link: r.invite || `${r.link}/?code=${r.code}`,
    rounds: r.rounds, roundChoices: ROUND_CHOICES, round: r.round, min: MIN_PLAYERS, max: MAX_PLAYERS,
    you: id, vip: id === vip(r), q: r.q, n, tol: tolerance(n), left: Math.max(0, r.deadline - Date.now()),
    mine: r.answers.get(id) || null, playing: r.inRound.includes(id), result: r.result,
    players: r.order.map((pid) => { const p = r.players.get(pid);
      return { id: pid, name: p.name, color: p.color, score: p.score, online: p.online, vip: pid === vip(r), done: r.answers.has(pid) }; }),
  };
}
const push = (r) => r.order.forEach((id) => send(r.players.get(id).ws, { t: "state", d: view(r, id) }));

function addPlayer(r, id, name, ws, dev) {
  r.players.set(id, { name, ws, dev, color: COLORS[r.order.length % COLORS.length], score: 0, online: true });
  r.order.push(id);
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

function later(r, sec, f) { clearTimeout(r.timer); r.timer = setTimeout(f, (sec * 1000) / SPEED); }

function startRound(r) {
  r.round++;
  r.inRound = online(r);
  let left = QUESTIONS.filter((q) => !r.used.has(q));
  if (!left.length) { r.used.clear(); left = QUESTIONS; }
  r.q = left[Math.floor(Math.random() * left.length)];
  r.used.add(r.q);
  r.answers = new Map();
  r.result = null;
  r.phase = "ask";
  r.deadline = Date.now() + (T.ask * 1000) / SPEED;
  later(r, T.ask, () => reveal(r));
  push(r);
}

// everyone still here has locked in: no need to wait for the timer
function checkAll(r) {
  if (r.phase !== "ask") return;
  const waiting = r.inRound.filter((id) => r.players.get(id).online && !r.answers.has(id));
  if (!waiting.length) reveal(r);
}

function reveal(r) {
  if (r.phase !== "ask") return;
  const n = r.inRound.length;
  const yes = r.inRound.filter((id) => r.answers.get(id)?.answer === true);
  const no = r.inRound.filter((id) => r.answers.get(id)?.answer === false);
  const gains = {};
  for (const id of r.inRound) {
    const a = r.answers.get(id);
    const gain = a ? points(a.guess, yes.length, n) : 0;
    r.players.get(id).score += gain;
    gains[id] = { gain, guess: a ? a.guess : null };
  }
  r.result = { yes, no, none: r.inRound.filter((id) => !r.answers.has(id)), gains };
  r.phase = "reveal";
  r.deadline = Date.now() + (T.reveal * 1000) / SPEED;
  later(r, T.reveal, () => next(r));
  push(r);
}

function next(r) {
  if (r.phase !== "reveal") return;
  if (r.round >= r.rounds || online(r).length < MIN_PLAYERS) { r.phase = "end"; r.deadline = 0; clearTimeout(r.timer); return push(r); }
  startRound(r);
}

function onPlayer(r, id, d) {
  if (!d || typeof d !== "object") return;
  const boss = id === vip(r);
  if (d.a === "start" && boss && r.phase === "lobby" && online(r).length >= MIN_PLAYERS) {
    r.round = 0; r.used.clear();
    r.order.forEach((pid) => { r.players.get(pid).score = 0; });
    startRound(r);
  } else if (d.a === "rounds" && boss && r.phase === "lobby" && ROUND_CHOICES.includes(d.value)) {
    r.rounds = d.value; push(r);
  } else if (d.a === "answer" && r.phase === "ask" && r.inRound.includes(id) && !r.answers.has(id)) {
    const n = r.inRound.length;
    if (typeof d.answer !== "boolean" || !Number.isInteger(d.guess) || d.guess < 0 || d.guess > n) return;
    r.answers.set(id, { answer: d.answer, guess: d.guess });
    push(r);
    checkAll(r);
  } else if (d.a === "next" && boss && r.phase === "reveal") {
    next(r);
  } else if (d.a === "restart" && boss && r.phase === "end") {
    r.phase = "lobby"; r.round = 0; r.result = null; r.inRound = []; push(r);
  } else if (d.a === "kick" && boss && d.id !== id) {
    kick(r, String(d.id));
  }
}

const stop = (r) => clearTimeout(r.timer);

module.exports = { createRoom, addPlayer, rejoin, leave, kick, onPlayer, push, points, tolerance, stop, MAX_PLAYERS };
