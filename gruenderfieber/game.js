// GRÜNDERFIEBER rules. Each round: everyone draws a brief (what · for whom · which problem), invents and draws a product
// with name and slogan, then pitches it while the others listen. After all pitches everyone shares their round budget
// among the other products. Whoever raises the most capital over all rounds wins.
// The boss may change the settings at any time; a running round keeps the ones it started with.
// Modes: "zufall" the game deals the cards (optionally the same for everyone), "auftrag" one player per round writes the
// brief for all others, "kette" every card passes through three players who each add one part, seeing the earlier ones,
// "problem" everyone writes only a problem, the next player invents whatever solves it.
const P = require("./prompts");
const S = require("./stats");

const SPEED = Number(process.env.SPEED) || 1; // tests run faster
const MIN_PLAYERS = 2, MAX_PLAYERS = 12; // two: each invests in the other; every pitch takes up to a minute and a half
const ROUND_CHOICES = [1, 2, 3];
const BUDGET = 100; // thousand euros per investor and round
const STEP = 5;
const T = { grace: 3, auftrag: 75, kette: 45, problem: 45, invest: 60, results: 25 }; // seconds
const MODES = ["zufall", "auftrag", "kette", "problem"];
const DRAW_CHOICES = [120, 180, 240, 300, 360];
const PITCH_CHOICES = [30, 60, 90];
const FIELDS = ["what", "who", "problem"];
const STEPS = { kette: FIELDS, problem: ["problem"] }; // ring modes: one field per pass
const PILE = { what: P.WHAT, who: P.WHO, problem: P.PROBLEM };
const COLORS = ["#3DDC97", "#FFC857", "#5B8CFF", "#FF6B6B", "#C77DFF", "#00C2D1", "#FF9F43", "#7BD389", "#F368E0", "#54A0FF", "#FECA57", "#48DBFB"];

const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const online = (r) => r.order.filter((id) => r.players.get(id).online);
// boss: the party leader while online, otherwise whoever joined first
const vip = (r) => online(r).find((id) => r.lead && r.players.get(id).dev === r.lead) || online(r)[0] || "";
const brief = () => ({ what: pick(P.WHAT), who: pick(P.WHO), problem: pick(P.PROBLEM) });

function createRoom(code, link) {
  return { code, link, invite: null, party: null, players: new Map(), order: [], phase: "lobby", round: 0,
    cfg: { rounds: 2, mode: "zufall", same: false, drawSecs: 180, pitchSecs: 60 }, play: null, write: null, setter: null, sent: new Set(),
    briefs: new Map(), ideas: new Map(), queue: [], cur: 0, stage: "", budget: new Map(), inv: new Map(), results: null,
    deadline: 0, timer: null, cleanup: null };
}

const presenter = (r) => r.queue[r.cur];
// everyone with a budget who has someone else's product to put money in
const investors = (r) => online(r).filter((id) => r.budget.has(id) && r.queue.some((q) => q !== id));
const imgUrl = (r, id) => `/img/${r.code}/${id}-${r.round}-${r.ideas.get(id).v}.png`;
function card(r, id) {
  const i = r.ideas.get(id), b = r.briefs.get(id);
  return { id, name: r.players.get(id).name, product: i.name, slogan: i.slogan, img: imgUrl(r, id), brief: b };
}

// one snapshot per player: everyone sees the stage, plus their own brief, budget and investment
function view(r, id) {
  const pid = presenter(r), c = r.cfg;
  return {
    phase: r.phase, stage: r.stage, code: r.code, party: r.party, link: r.invite || `${r.link}/?code=${r.code}`,
    rounds: c.rounds, roundChoices: ROUND_CHOICES, round: r.round, min: MIN_PLAYERS, max: MAX_PLAYERS, budgetMax: BUDGET, step: STEP,
    mode: c.mode, same: c.same, drawSecs: c.drawSecs, drawChoices: DRAW_CHOICES, pitchSecs: c.pitchSecs, pitchChoices: PITCH_CHOICES, total: total(r),
    write: r.write && { kind: r.write.kind, step: r.write.step, setter: r.write.setter && r.players.get(r.write.setter).name, task: task(r, id), done: r.write.done.has(id) },
    setter: r.setter === id, rerollable: !!r.play && r.play.mode === "zufall" && !r.play.same,
    you: id, vip: id === vip(r), left: Math.max(0, r.deadline - Date.now()),
    brief: r.briefs.get(id) || null, rerolled: !!r.briefs.get(id)?.rerolled, submitted: r.ideas.has(id), playing: r.briefs.has(id),
    pitch: r.phase === "pitch" && pid ? { ...card(r, pid), index: r.cur + 1, count: r.queue.length } : null,
    invest: r.phase === "invest" ? { products: r.queue.map((q) => card(r, q)), can: investors(r).includes(id), sent: r.sent.has(id),
      decided: r.sent.size, needed: investors(r).length } : null,
    budget: r.budget.get(id) ?? 0,
    results: r.results,
    players: r.order.map((p) => { const q = r.players.get(p);
      return { id: p, name: q.name, color: q.color, money: q.money, online: q.online, vip: p === vip(r), done: r.phase === "write" ? r.write.done.has(p) : r.ideas.has(p) }; }),
  };
}
// length of the current phase in seconds, for the phones' timer bar
function total(r) {
  if (r.phase === "write") return T[r.write.kind];
  if (r.phase === "develop") return r.play.drawSecs;
  if (r.phase === "pitch") return r.play.pitchSecs;
  if (r.phase === "invest") return T.invest;
  return r.phase === "results" ? T.results : 0;
}
// what this player has to write right now (write phase), or null
function task(r, id) {
  const w = r.write;
  if (!w) return null;
  if (w.kind === "auftrag") return id === w.setter ? { fields: FIELDS, prev: {} } : null;
  const i = w.ring.indexOf(id);
  if (i < 0) return null;
  const k = (i - w.step + w.ring.length) % w.ring.length, c = w.chains[k];
  return { k, fields: [STEPS[w.kind][w.step]], prev: { what: c.what, who: c.who } };
}
const push = (r) => r.order.forEach((id) => send(r.players.get(id).ws, { t: "state", d: view(r, id) }));
function later(r, sec, f) { clearTimeout(r.timer); r.timer = setTimeout(f, (sec * 1000) / SPEED); r.deadline = Date.now() + (sec * 1000) / SPEED; }

function addPlayer(r, id, name, ws, dev) {
  r.players.set(id, { name, ws, dev, color: COLORS[r.order.length % COLORS.length], money: 0, online: true });
  r.order.push(id);
  S.log("join", r.code, dev, { name, phase: r.phase });
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
  r.play = { ...r.cfg }; // settings changed from now on apply to the next round
  const ids = online(r), mode = r.play.mode;
  r.briefs = new Map(); r.ideas = new Map(); r.inv = new Map(); r.sent = new Set(); r.results = null; r.setter = null;
  r.budget = new Map(ids.map((id) => [id, BUDGET]));
  r.stage = "";
  if (mode === "auftrag") { // the client rotates every round
    r.setter = ids[(r.round - 1) % ids.length];
    r.write = { kind: "auftrag", setter: r.setter, step: 0, done: new Set(), parts: {} };
  } else if (STEPS[mode]) {
    const ring = shuffle([...ids]);
    r.write = { kind: mode, ring, step: 0, done: new Set(), chains: ring.map(() => ({ by: [] })) };
  }
  if (r.write) { r.phase = "write"; later(r, T[r.write.kind], () => endWrite(r)); return push(r); }
  const shared = r.play.same ? brief() : null;
  ids.forEach((id) => r.briefs.set(id, shared ? { ...shared } : brief()));
  develop(r);
}
function develop(r) {
  r.write = null;
  r.phase = "develop";
  later(r, r.play.drawSecs + T.grace, () => startPitches(r)); // the grace lets phones auto-submit what they have
  push(r);
}

// a write step is over (all done or time up): empty parts get a random card, then the next step or the drawing
function endWrite(r) {
  if (r.phase !== "write") return;
  const w = r.write, fill = (o, f) => { if (!o[f]) o[f] = pick(PILE[f]); };
  if (w.kind === "auftrag") {
    FIELDS.forEach((f) => fill(w.parts, f));
    const b = { ...w.parts, by: [r.players.get(w.setter).name] };
    online(r).filter((id) => id !== w.setter).forEach((id) => r.briefs.set(id, { ...b }));
    return develop(r);
  }
  const steps = STEPS[w.kind];
  w.chains.forEach((c) => fill(c, steps[w.step]));
  if (w.step < steps.length - 1) { w.step++; w.done = new Set(); later(r, T[w.kind], () => endWrite(r)); return push(r); }
  // every card goes to the player after the ones who wrote it
  w.chains.forEach((c, k) => {
    const dev = w.ring[(k + steps.length) % w.ring.length];
    if (r.players.get(dev).online) r.briefs.set(dev, { what: c.what, who: c.who, problem: c.problem, by: c.by });
  });
  develop(r);
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
function talk(r) { r.stage = "talk"; later(r, r.play.pitchSecs, () => nextPitch(r)); push(r); }
function nextPitch(r) {
  if (r.phase !== "pitch") return;
  r.cur++;
  if (r.cur < r.queue.length) return talk(r);
  // all pitched: now everyone shares their budget among the others' products
  r.phase = "invest"; r.stage = "";
  later(r, T.invest + T.grace, () => showResults(r)); // the grace lets phones hand in what they have set
  push(r);
  check(r);
}

function showResults(r) {
  if (r.phase !== "invest" && r.phase !== "develop") return;
  const list = r.queue.map((id) => {
    const got = [...r.inv.get(id)].filter(([, a]) => a > 0);
    const raised = got.reduce((s, [, a]) => s + a, 0);
    r.players.get(id).money += raised;
    return { ...card(r, id), raised, investors: got.map(([inv, amount]) => ({ name: r.players.get(inv).name, amount })) };
  }).sort((a, b) => b.raised - a.raised);
  r.results = { list };
  list.forEach((x) => S.log("idea", r.code, r.players.get(x.id).dev, { round: r.round, mode: r.play.mode, players: r.queue.length,
    product: x.product, slogan: x.slogan, brief: { what: x.brief.what, who: x.brief.who, problem: x.brief.problem }, raised: x.raised, investors: x.investors.length }));
  if (r.round >= r.cfg.rounds) S.log("game_end", r.code, null, { players: online(r).length, rounds: r.round });
  r.phase = r.round >= r.cfg.rounds ? "end" : "results";
  r.stage = "";
  if (r.phase === "results") later(r, T.results, () => { if (r.phase === "results") startRound(r); });
  else { clearTimeout(r.timer); r.deadline = 0; }
  push(r);
}

// move on early when everyone who still has to act has acted
function check(r) {
  if (r.phase === "write") {
    if (online(r).filter((id) => task(r, id)).every((id) => r.write.done.has(id))) endWrite(r);
  } else if (r.phase === "develop") {
    if (online(r).filter((id) => r.briefs.has(id)).every((id) => r.ideas.has(id))) startPitches(r);
  } else if (r.phase === "pitch") {
    const pid = presenter(r);
    if (!r.players.get(pid).online) nextPitch(r); // presenter gone: next one
  } else if (r.phase === "invest") {
    if (investors(r).every((id) => r.sent.has(id))) showResults(r);
  }
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function onPlayer(r, id, d) {
  if (!d || typeof d !== "object") return;
  const boss = id === vip(r);
  if (d.a === "start" && boss && r.phase === "lobby" && online(r).length >= MIN_PLAYERS) {
    r.round = 0;
    r.order.forEach((p) => { r.players.get(p).money = 0; });
    S.log("game_start", r.code, null, { players: online(r).length, party: !!r.party, ...r.cfg });
    startRound(r);
  } else if (d.a === "rounds" && boss && ROUND_CHOICES.includes(d.value)) {
    r.cfg.rounds = d.value; push(r);
  } else if (d.a === "settings" && boss) { // any time; a running round keeps its own copy (r.play)
    if (MODES.includes(d.mode)) r.cfg.mode = d.mode;
    if (typeof d.same === "boolean") r.cfg.same = d.same;
    if (DRAW_CHOICES.includes(d.draw)) r.cfg.drawSecs = d.draw;
    if (PITCH_CHOICES.includes(d.pitch)) r.cfg.pitchSecs = d.pitch;
    push(r);
  } else if (d.a === "write" && r.phase === "write" && task(r, id) && !r.write.done.has(id)) {
    const t = task(r, id), w = r.write, name = r.players.get(id).name;
    const target = w.kind === "auftrag" ? w.parts : w.chains[t.k];
    t.fields.forEach((f) => { const v = clean(d[f], 60); if (v) target[f] = v; });
    if (w.kind !== "auftrag") target.by.push(name);
    w.done.add(id);
    push(r); check(r);
  } else if (d.a === "reroll" && r.play?.mode === "zufall" && !r.play.same && r.phase === "develop" && r.briefs.has(id) && !r.briefs.get(id).rerolled && !r.ideas.has(id)) {
    r.briefs.set(id, { ...brief(), rerolled: true }); push(r);
  } else if (d.a === "submit" && r.phase === "develop" && r.briefs.has(id) && !r.ideas.has(id) && Buffer.isBuffer(d.img)) {
    r.ideas.set(id, { name: clean(d.name, 30) || "Namenlos", slogan: clean(d.slogan, 90), img: d.img, v: Date.now().toString(36) });
    push(r); check(r);
  } else if (d.a === "done" && r.phase === "pitch" && (id === presenter(r) || boss)) {
    nextPitch(r);
  } else if (d.a === "invest" && r.phase === "invest" && investors(r).includes(id) && !r.sent.has(id) && d.alloc && typeof d.alloc === "object") {
    // the whole split in one message, { productOwnerId: amount }: only others' products, steps of STEP, within the budget
    const split = Object.entries(d.alloc).map(([to, a]) => [to, Number(a)]).filter(([, a]) => a !== 0);
    if (split.some(([to, a]) => to === id || !r.inv.has(to) || !Number.isInteger(a) || a < 0 || a % STEP)) return;
    const sum = split.reduce((t, [, a]) => t + a, 0);
    if (sum > r.budget.get(id)) return;
    split.forEach(([to, a]) => r.inv.get(to).set(id, a));
    r.budget.set(id, r.budget.get(id) - sum);
    r.sent.add(id);
    push(r); check(r);
  } else if (d.a === "next" && boss && r.phase === "results") {
    startRound(r);
  } else if (d.a === "restart" && boss && r.phase === "end") {
    r.phase = "lobby"; r.round = 0; r.play = null; r.results = null; r.briefs = new Map(); r.ideas = new Map(); r.write = null; r.setter = null; push(r);
  } else if (d.a === "kick" && boss && d.id !== id) {
    kick(r, String(d.id));
  }
}

// drawings are served over http so the state stays small
function image(r, id) { return r.ideas.get(id)?.img || null; }
const stop = (r) => clearTimeout(r.timer);

module.exports = { createRoom, addPlayer, rejoin, leave, kick, onPlayer, push, image, stop, MAX_PLAYERS, BUDGET };
