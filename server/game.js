// Game rules and flow. Runs on the server so nothing stalls when a browser tab is hidden.
// Phones get small per-player screens ({s: ...}); the optional big screen gets a full "view" snapshot.
const C = require("./content");

const SPEED = Number(process.env.SPEED) || 1; // tests run faster
const ROUNDS = 3;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 20;
const T = { answer: 60, twist: 75, vote: 30, grace: 1.5, title: 2.4, head: 3.5, body: 5.5, origin: 4, board: 9, scores: 7 };
const PTS_TWIST = 100, PTS_PITY = 40;

const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function createRoom(code, link) {
  return { code, link, host: null, players: new Map(), order: [], phoneMode: false, phase: "lobby", round: 0,
    showOrigin: false, posts: [], votes: new Map(), used: new Set(), gen: 0, deadline: 0, len: 0, graceMs: 0, beat: null,
    counts: [], gains: {}, timers: [], cleanup: null };
}

// ---------------------------------------------------------------- helpers
const online = (r) => r.order.filter((id) => r.players.get(id).online);
const vip = (r) => online(r)[0] || "";
const nameOf = (r, id) => r.players.get(id).name;
const inRound = (r, id) => r.posts.some((p) => p.answerer === id);
const ranked = (r) => [...r.order].sort((a, b) => r.players.get(b).score - r.players.get(a).score);

function to(r, id, d) {
  const p = r.players.get(id);
  d.color = p.color;
  d.code = r.code;
  p.state = d;
  send(p.ws, { t: "msg", d });
}

function payload(r, p) {
  return { f: p.fmt.id, fname: p.fmt.name, twist: p.twist, answer: p.answer, who: nameOf(r, p.answerer),
    color: r.players.get(p.answerer).color, prompt: p.prompt, twister: nameOf(r, p.twister),
    aDone: !!p.answer, tDone: !!p.twist, aOnline: r.players.get(p.answerer).online, tOnline: r.players.get(p.twister).online };
}

function secret(r, p) {
  const pl = payload(r, p);
  delete pl.twister;
  if (!r.showOrigin) delete pl.prompt;
  return pl;
}

function view(r) {
  if (!r.host) return;
  const left = r.deadline ? Math.max(0, (r.deadline - Date.now() - r.graceMs) / 1000) : 0;
  send(r.host, { t: "view", v: {
    phase: r.phase, round: r.round, rounds: ROUNDS, phoneMode: r.phoneMode, showOrigin: r.showOrigin, link: r.link,
    players: r.order.map((id) => { const p = r.players.get(id); return { id, name: p.name, color: p.color, score: p.score, online: p.online, vip: id === vip(r) }; }),
    posts: r.posts.map((p) => payload(r, p)), left, len: r.len, voted: r.votes.size,
    beat: r.beat, counts: r.counts, gains: r.gains,
  } });
}

function setPhase(r, phase, sec = 0, grace = 0) {
  r.phase = phase;
  r.gen++;
  r.timers.forEach(clearTimeout);
  r.timers = [];
  r.len = sec / SPEED;
  r.graceMs = (grace * 1000) / SPEED;
  r.deadline = sec ? Date.now() + ((sec + grace) * 1000) / SPEED : 0;
  if (sec) sleep(r, sec + grace).then((ok) => ok && onTimeout(r));
}

// resolves true after `sec`, or never if the phase changed meanwhile
function sleep(r, sec) {
  const g = r.gen;
  return new Promise((res) => r.timers.push(setTimeout(() => res(r.gen === g), (sec * 1000) / SPEED)));
}

function pickPrompt(r) {
  let pool = C.PROMPTS.filter((p) => !r.used.has(p));
  if (!pool.length) { r.used.clear(); pool = C.PROMPTS; }
  const p = pick(pool);
  r.used.add(p);
  return p;
}

// ---------------------------------------------------------------- players

function addPlayer(r, id, name, ws) {
  r.players.set(id, { name, ws, color: C.PLAYER_COLORS[r.order.length % C.PLAYER_COLORS.length], score: 0, online: true, state: {} });
  r.order.push(id);
  if (r.phase === "lobby") pushLobby(r);
  else to(r, id, { s: "wait", title: "Gleich bist du dabei.", text: "Ab der nächsten Runde spielst du mit." });
  view(r);
}

function rejoin(r, id, ws) {
  const p = r.players.get(id);
  p.ws = ws;
  p.online = true;
  if (r.phase === "lobby") pushLobby(r);
  else to(r, id, p.state);
  view(r);
}

function leave(r, id) {
  r.players.get(id).online = false;
  if (r.phase === "lobby") pushLobby(r);
  view(r);
  checkDone(r);
}

function onPlayer(r, id, d) {
  if (!d || typeof d !== "object") return;
  const key = String(d.key ?? "");
  if (d.a === "start" && r.phase === "lobby" && id === vip(r) && online(r).length >= MIN_PLAYERS) startGame(r);
  else if (d.a === "restart" && r.phase === "end" && id === vip(r)) toLobby(r);
  else if (d.a === "mode" && r.phase === "lobby" && id === vip(r)) setMode(r, d.phone);
  else if (d.a === "origin" && r.phase === "lobby" && id === vip(r)) setOrigin(r, d.on);
  else if (d.a === "submit" && r.phase === "answer" && key === `a${r.round}`) {
    for (const p of r.posts) if (p.answerer === id && !p.answer) p.answer = clean(d.text, 80);
    view(r); checkDone(r);
  } else if (d.a === "submit" && r.phase === "twist" && key === `t${r.round}`) {
    for (const p of r.posts) if (p.twister === id && !p.twist) p.twist = clean(d.text, 70);
    view(r); checkDone(r);
  } else if (d.a === "vote" && r.phase === "vote" && key === `v${r.round}` && inRound(r, id) && !r.votes.has(id)) {
    const i = Number(d.i);
    if (Number.isInteger(i) && i >= 0 && i < r.posts.length && r.posts[i].twister !== id) {
      r.votes.set(id, i);
      view(r); checkDone(r);
    }
  }
}

function setOrigin(r, on) {
  r.showOrigin = !!on;
  pushLobby(r);
  view(r);
}

function setMode(r, phone) {
  r.phoneMode = !!phone;
  pushLobby(r);
  view(r);
}

// ---------------------------------------------------------------- flow

function pushLobby(r) {
  for (const id of r.order)
    to(r, id, { s: "lobby", vip: id === vip(r), count: online(r).length, min: MIN_PLAYERS, max: MAX_PLAYERS,
      players: online(r).map((pid) => ({ name: nameOf(r, pid), color: r.players.get(pid).color, vip: pid === vip(r) })), phoneMode: r.phoneMode, showOrigin: r.showOrigin, link: `${r.link}/?code=${r.code}`, hasHost: !!r.host });
}

function toLobby(r) {
  for (const id of [...r.order]) if (!r.players.get(id).online) { r.players.delete(id); r.order.splice(r.order.indexOf(id), 1); }
  setPhase(r, "lobby");
  r.posts = [];
  pushLobby(r);
  view(r);
}

function startGame(r) {
  for (const p of r.players.values()) p.score = 0;
  r.round = 0;
  r.used.clear();
  nextRound(r);
}

function waitOthers(r) {
  for (const id of r.order)
    if (!inRound(r, id)) to(r, id, { s: "wait", title: "Gleich bist du dabei.", text: "Ab der nächsten Runde spielst du mit." });
}

function nextRound(r) {
  r.round++;
  const ids = shuffle(online(r));
  const fmts = shuffle([...C.FORMATS]);
  r.posts = ids.map((id, i) => ({ answerer: id, twister: ids[(i + 1) % ids.length], prompt: pickPrompt(r), fmt: fmts[i % fmts.length], answer: "", twist: "" }));
  setPhase(r, "answer", T.answer, T.grace);
  for (const p of r.posts)
    to(r, p.answerer, { s: "write", key: `a${r.round}`, tag: `Runde ${r.round} · Ehrlich sein`, title: p.prompt,
      placeholder: "Ehrlich. Kurz. Harmlos.", max: 80, seconds: T.answer / SPEED });
  waitOthers(r);
  view(r);
}

function endAnswer(r) {
  for (const p of r.posts) if (!p.answer) p.answer = pick(C.NO_ANSWER);
  setPhase(r, "twist", T.twist, T.grace);
  for (const p of r.posts) {
    // the twister sees the answer in its new context, never the question behind it
    const post = payload(r, p);
    delete post.prompt;
    delete post.twist;
    to(r, p.twister, { s: "write", key: `t${r.round}`, tag: `Runde ${r.round} · Verdrehen · ${p.fmt.name}`, post,
      placeholder: `${p.fmt.label} – ${p.fmt.hint}`, max: 70, seconds: T.twist / SPEED });
  }
  waitOthers(r);
  view(r);
}

async function reveal(r) {
  for (const p of r.posts) if (!p.twist) p.twist = p.fmt.fallback;
  setPhase(r, "reveal");
  r.beat = { title: true };
  for (const id of r.order)
    to(r, id, { s: "wait", title: `Runde ${r.round}`, text: r.phoneMode ? "Was das Internet daraus gemacht hat …" : "Augen nach vorn. Jetzt wird's peinlich." });
  view(r);
  if (!(await sleep(r, T.title))) return;
  // each post in beats: twist alone → the answer drops in → (optional) the innocent question behind it
  const quick = r.posts.length > 8 ? 0.7 : 1; // big groups: keep a round under ~3 minutes
  const beats = [[1, T.head * quick], [2, T.body * quick], ...(r.showOrigin ? [[3, T.origin * quick]] : [])];
  for (let i = 0; i < r.posts.length; i++) {
    for (const [stage, sec] of beats) {
      r.beat = { i, stage };
      view(r);
      if (r.phoneMode)
        for (const id of r.order)
          to(r, id, { s: "reveal", stage, post: secret(r, r.posts[i]), tag: `Post ${i + 1} von ${r.posts.length} · ${r.posts[i].fmt.name}` });
      if (!(await sleep(r, sec))) return;
    }
  }
  startVote(r);
}

function startVote(r) {
  r.votes.clear();
  r.beat = null;
  setPhase(r, "vote", T.vote);
  for (const p of r.posts) {
    const options = [];
    r.posts.forEach((q, i) => {
      if (q.twister !== p.answerer) options.push({ i, tag: q.fmt.name, text: `${q.twist} — „${q.answer}“`, post: secret(r, q) });
    });
    to(r, p.answerer, { s: "vote", key: `v${r.round}`, title: "Welcher Post ist am schlimmsten?", options, full: r.phoneMode, seconds: T.vote / SPEED });
  }
  waitOthers(r);
  view(r);
}

async function endVote(r) {
  setPhase(r, "results");
  r.counts = r.posts.map(() => 0);
  for (const i of r.votes.values()) r.counts[i]++;
  r.gains = {};
  for (const id of r.order) r.gains[id] = 0;
  r.posts.forEach((p, i) => {
    r.gains[p.twister] += r.counts[i] * PTS_TWIST * r.round;
    r.gains[p.answerer] += r.counts[i] * PTS_PITY * r.round;
  });
  for (const id of r.order) r.players.get(id).score += r.gains[id];
  // only now is it revealed who twisted what
  const items = r.posts.map((p, i) => ({ post: payload(r, p), votes: r.counts[i] }));
  for (const id of r.order)
    to(r, id, r.phoneMode ? { s: "results", items }
      : { s: "wait", title: "Auszählung.", text: `+${r.gains[id]} Punkte diese Runde. Schau nach vorn, wer was verdreht hat.` });
  view(r);
  if (!(await sleep(r, T.board))) return;
  r.phase = "scores";
  const rows = ranked(r).map((id) => { const p = r.players.get(id); return { name: p.name, color: p.color, score: p.score, gain: r.gains[id] }; });
  if (r.phoneMode) for (const id of r.order) to(r, id, { s: "scores", title: `Runde ${r.round} vorbei.`, rows, gain: r.gains[id] });
  view(r);
  if (!(await sleep(r, T.scores))) return;
  if (r.round < ROUNDS) nextRound(r);
  else endGame(r);
}

function endGame(r) {
  setPhase(r, "end");
  ranked(r).forEach((id, i) => to(r, id, { s: "end", place: i + 1, text: `${r.players.get(id).score} Punkte`, vip: id === vip(r) }));
  view(r);
}

function onTimeout(r) {
  if (r.phase === "answer") endAnswer(r);
  else if (r.phase === "twist") reveal(r);
  else if (r.phase === "vote") endVote(r);
}

function checkDone(r) {
  const off = (id) => !r.players.get(id).online;
  if (r.phase === "answer" && r.posts.every((p) => p.answer || off(p.answerer))) endAnswer(r);
  else if (r.phase === "twist" && r.posts.every((p) => p.twist || off(p.twister))) reveal(r);
  else if (r.phase === "vote" && r.posts.every((p) => r.votes.has(p.answerer) || off(p.answerer))) endVote(r);
}

module.exports = { createRoom, addPlayer, rejoin, leave, onPlayer, setMode, setOrigin, view, pushLobby, MAX_PLAYERS };
