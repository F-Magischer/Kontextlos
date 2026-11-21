// GRÜNDERFIEBER rules. Each round: everyone draws a brief (what · for whom · which problem), invents and draws a product
// with name and slogan, then pitches it while the others listen; after each pitch the others invest from their
// round budget. Whoever raises the most capital over all rounds wins.
const P = require("./prompts");

const SPEED = Number(process.env.SPEED) || 1; // tests run faster
const MIN_PLAYERS = 3, MAX_PLAYERS = 12; // at least two investors per pitch; every pitch takes a minute
const ROUND_CHOICES = [1, 2, 3];
const BUDGET = 100; // thousand euros per investor and round
const STEP = 5;
const T = { develop: 180, grace: 3, talk: 60, invest: 25, results: 25 }; // seconds
const COLORS = ["#3DDC97", "#FFC857", "#5B8CFF", "#FF6B6B", "#C77DFF", "#00C2D1", "#FF9F43", "#7BD389", "#F368E0", "#54A0FF", "#FECA57", "#48DBFB"];

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const online = (r) => r.order.filter((id) => r.players.get(id).online);
const vip = (r) => online(r)[0] || "";
const brief = () => ({ what: pick(P.WHAT), who: pick(P.WHO), problem: pick(P.PROBLEM) });

function createRoom(code, link) {
  return { code, link, invite: null, party: null, players: new Map(), order: [], phase: "lobby", rounds: 2, round: 0,
    briefs: new Map(), ideas: new Map(), queue: [], cur: 0, stage: "", budget: new Map(), inv: new Map(), results: null,
    deadline: 0, timer: null, cleanup: null };
}

const presenter = (r) => r.queue[r.cur];
const investors = (r) => online(r).filter((id) => id !== presenter(r) && r.budget.has(id));
const imgUrl = (r, id) => `/img/${r.code}/${id}-${r.round}-${r.ideas.get(id).v}.png`;
function card(r, id) {
  const i = r.ideas.get(id), b = r.briefs.get(id);
  return { id, name: r.players.get(id).name, product: i.name, slogan: i.slogan, img: imgUrl(r, id), brief: b };
}

// one snapshot per player: everyone sees the stage, plus their own brief, budget and investment
function view(r, id) {
  const pid = presenter(r), inv = pid ? r.inv.get(pid) : null;
  return {
    phase: r.phase, stage: r.stage, code: r.code, party: r.party, link: r.invite || `${r.link}/?code=${r.code}`,
    rounds: r.rounds, roundChoices: ROUND_CHOICES, round: r.round, min: MIN_PLAYERS, max: MAX_PLAYERS, budgetMax: BUDGET, step: STEP,
    you: id, vip: id === vip(r), left: Math.max(0, r.deadline - Date.now()),
    brief: r.briefs.get(id) || null, rerolled: !!r.briefs.get(id)?.rerolled, submitted: r.ideas.has(id), playing: r.briefs.has(id),
    pitch: r.phase === "pitch" && pid ? { ...card(r, pid), index: r.cur + 1, count: r.queue.length,
      decided: inv.size, needed: investors(r).length, mine: inv.has(id) ? inv.get(id) : null } : null,
    budget: r.budget.get(id) ?? 0,
    results: r.results,
    players: r.order.map((p) => { const q = r.players.get(p);
      return { id: p, name: q.name, color: q.color, money: q.money, online: q.online, vip: p === vip(r), done: r.ideas.has(p) }; }),
  };
}
const push = (r) => r.order.forEach((id) => send(r.players.get(id).ws, { t: "state", d: view(r, id) }));
function later(r, sec, f) { clearTimeout(r.timer); r.timer = setTimeout(f, (sec * 1000) / SPEED); r.deadline = Date.now() + (sec * 1000) / SPEED; }

function addPlayer(r, id, name, ws, dev) {
  r.players.set(id, { name, ws, dev, color: COLORS[r.order.length % COLORS.length], money: 0, online: true });
  r.order.push(id);
  push(r);
}
function rejoin(r, id, ws) { const p = r.players.get(id); p.ws = ws; p.online = true; push(r); }
function leave(r, id) { r.players.get(id).online = false; push(r); check(r); }

function kick(r, id) {
  const p = r.players.get(id);
  if (!p) return;
  const ws = p.ws;
  p.ws = null; p.online = false; p.kicked = true;
  send(ws, { t: "error", msg: "Du wurdest aus dem Raum geworfen." });
  if (ws) ws.close();
  if (r.phase === "lobby") { r.players.delete(id); r.order.splice(r.order.indexOf(id), 1); }
  push(r);
  check(r);
}

// ---------------------------------------------------------------- flow
function startRound(r) {
  r.round++;
  r.briefs = new Map(online(r).map((id) => [id, brief()]));
  r.ideas = new Map();
  r.budget = new Map(online(r).map((id) => [id, BUDGET]));
  r.inv = new Map();
  r.results = null;
  r.phase = "develop"; r.stage = "";
  later(r, T.develop + T.grace, () => startPitches(r)); // the grace lets phones auto-submit what they have
  push(r);
}

function startPitches(r) {
  if (r.phase !== "develop") return;
  r.queue = shuffle([...r.ideas.keys()]);
  r.queue.forEach((id) => r.inv.set(id, new Map()));
  r.cur = 0;
  if (!r.queue.length) return showResults(r);
  r.phase = "pitch";
  talk(r);
}
function talk(r) { r.stage = "talk"; later(r, T.talk, () => invest(r)); push(r); }
function invest(r) {
  if (r.phase !== "pitch") return;
  r.stage = "invest";
  later(r, T.invest, () => nextPitch(r));
  push(r);
  check(r);
}
function nextPitch(r) {
  if (r.phase !== "pitch") return;
  r.cur++;
  if (r.cur >= r.queue.length) return showResults(r);
  talk(r);
}

function showResults(r) {
  const list = r.queue.map((id) => {
    const got = [...r.inv.get(id)].filter(([, a]) => a > 0);
    const raised = got.reduce((s, [, a]) => s + a, 0);
    r.players.get(id).money += raised;
    return { ...card(r, id), raised, investors: got.map(([inv, amount]) => ({ name: r.players.get(inv).name, amount })) };
  }).sort((a, b) => b.raised - a.raised);
  r.results = { list };
  r.phase = r.round >= r.rounds ? "end" : "results";
  r.stage = "";
  if (r.phase === "results") later(r, T.results, () => { if (r.phase === "results") startRound(r); });
  else { clearTimeout(r.timer); r.deadline = 0; }
  push(r);
}

// move on early when everyone who still has to act has acted
function check(r) {
  if (r.phase === "develop") {
    if (online(r).filter((id) => r.briefs.has(id)).every((id) => r.ideas.has(id))) startPitches(r);
  } else if (r.phase === "pitch") {
    const pid = presenter(r);
    if (r.stage === "talk" && !r.players.get(pid).online) invest(r); // presenter gone: straight to the money
    else if (r.stage === "invest" && investors(r).every((id) => r.inv.get(pid).has(id))) nextPitch(r);
  }
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function onPlayer(r, id, d) {
  if (!d || typeof d !== "object") return;
  const boss = id === vip(r);
  if (d.a === "start" && boss && r.phase === "lobby" && online(r).length >= MIN_PLAYERS) {
    r.round = 0;
    r.order.forEach((p) => { r.players.get(p).money = 0; });
    startRound(r);
  } else if (d.a === "rounds" && boss && r.phase === "lobby" && ROUND_CHOICES.includes(d.value)) {
    r.rounds = d.value; push(r);
  } else if (d.a === "reroll" && r.phase === "develop" && r.briefs.has(id) && !r.briefs.get(id).rerolled && !r.ideas.has(id)) {
    r.briefs.set(id, { ...brief(), rerolled: true }); push(r);
  } else if (d.a === "submit" && r.phase === "develop" && r.briefs.has(id) && !r.ideas.has(id) && Buffer.isBuffer(d.img)) {
    r.ideas.set(id, { name: clean(d.name, 30) || "Namenlos", slogan: clean(d.slogan, 90), img: d.img, v: Date.now().toString(36) });
    push(r); check(r);
  } else if (d.a === "done" && r.phase === "pitch" && r.stage === "talk" && (id === presenter(r) || boss)) {
    invest(r);
  } else if (d.a === "invest" && r.phase === "pitch" && r.stage === "invest" && id !== presenter(r) && r.budget.has(id)) {
    const inv = r.inv.get(presenter(r));
    const amount = Number(d.amount);
    if (inv.has(id) || !Number.isInteger(amount) || amount < 0 || amount % STEP || amount > r.budget.get(id)) return;
    inv.set(id, amount);
    r.budget.set(id, r.budget.get(id) - amount);
    push(r); check(r);
  } else if (d.a === "next" && boss && r.phase === "results") {
    startRound(r);
  } else if (d.a === "restart" && boss && r.phase === "end") {
    r.phase = "lobby"; r.round = 0; r.results = null; r.briefs = new Map(); r.ideas = new Map(); push(r);
  } else if (d.a === "kick" && boss && d.id !== id) {
    kick(r, String(d.id));
  }
}

// drawings are served over http so the state stays small
function image(r, id) { return r.ideas.get(id)?.img || null; }
const stop = (r) => clearTimeout(r.timer);

module.exports = { createRoom, addPlayer, rejoin, leave, kick, onPlayer, push, image, stop, MAX_PLAYERS, BUDGET };
