// Play data of the FURIDA website, plus /data: one overview of the website and all games, behind DATA_PASSWORD
// (HTTP Basic auth; any user name). Every service writes its own table in the same Postgres (Neon) database:
// events (KONTEXTLOS), jasager_events, gruenderfieber_events, party_events (this site). Without DATABASE_URL nothing is stored.
const crypto = require("crypto");

const TABLE = "party_events";
const SOURCES = [ // table, name, game id (null: the website)
  ["party_events", "FURIDA-Website", null],
  ["events", "KONTEXTLOS", "kontextlos"],
  ["jasager_events", "JA-SAGER", "jasager"],
  ["gruenderfieber_events", "GRÜNDERFIEBER", "gruenderfieber"],
];
const db = process.env.DATABASE_URL ? new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, max: 3, ssl: { rejectUnauthorized: false } }) : null;
// all four tables, so the overview works before a game has written anything
const ready = db
  ? db.query(SOURCES.map(([t]) => `create table if not exists ${t} (id bigserial primary key, ts timestamptz not null default now(), type text not null, room text, dev text, data jsonb);
      create index if not exists ${t}_type_ts on ${t} (type, ts);`).join("\n")).catch((e) => console.error("stats: setup failed", e.message))
  : Promise.resolve();

// fire and forget: the site never waits for or fails on the database
function log(type, room, dev, data) {
  if (!db) return;
  ready.then(() => db.query(`insert into ${TABLE} (type, room, dev, data) values ($1,$2,$3,$4)`, [type, room || null, dev || null, data || null]))
    .catch((e) => console.error("stats:", e.message));
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DAY = "(ts at time zone 'Europe/Berlin')::date";
const pct = (n, d) => (d ? Math.round((100 * n) / d) + " %" : "–");
const num = (v, dig = 1) => (v == null ? "–" : Number(v).toFixed(dig));
const day = (d) => d.toISOString().slice(0, 10);
const time = (t) => t.toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });

function authed(req) {
  const pw = process.env.DATA_PASSWORD;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!pw || !m) return false;
  const given = Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":");
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(given).digest(), crypto.createHash("sha256").update(pw).digest());
}

const table = (head, rows) => `<div class="w"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${head.length}">noch nichts</td></tr>`}</table></div>`;
// one row per visitor of the site, one per player joining a game room
const people = (t) => (t === TABLE ? "type = 'visit'" : "type = 'join' and coalesce(dev, '') <> ''");

async function page(req, res, live, games) {
  if (!process.env.DATA_PASSWORD) return res.writeHead(404).end("not found");
  if (!authed(req)) return res.writeHead(401, { "WWW-Authenticate": 'Basic realm="FURIDA-Daten"' }).end("Passwort nötig");
  let body = `<p class="big">Gerade auf der Website: <b>${live.players}</b> Leute in <b>${live.parties}</b> Parties</p>`;
  if (!db) body += "<p>Keine DATABASE_URL gesetzt, es wird nichts gespeichert.</p>";
  else {
    await ready;
    const sum = SOURCES.map(([t, name]) => `select '${name}' src, ${SOURCES.findIndex((s) => s[0] === t)} o,
        count(distinct dev) filter (where ${people(t)} and ts > now() - interval '1 day') d1,
        count(distinct dev) filter (where ${people(t)} and ts > now() - interval '7 days') d7,
        count(distinct dev) filter (where ${people(t)}) d30,
        count(distinct dev) filter (where ${people(t)} and dev like 'party:%') viaParty,
        count(*) filter (where type = 'game_start') games, count(*) filter (where type = 'game_end') ended,
        max((data->>'players')::int) filter (where type = 'ccu' and ts > now() - interval '3 minutes') now,
        max((data->>'players')::int) filter (where type = 'ccu') peak
      from ${t} where ts > now() - interval '30 days'`).join(" union all ") + " order by o";
    const perDay = `select d, ${SOURCES.map((_, i) => `max(p${i}) p${i}, max(g${i}) g${i}`).join(", ")} from (${SOURCES.map(([t], i) =>
      `select ${DAY} d, ${SOURCES.map((_, j) => (j === i ? `count(distinct dev) filter (where ${people(t)}) p${j}, count(*) filter (where type = 'game_start') g${j}` : `null::bigint p${j}, null::bigint g${j}`)).join(", ")}
        from ${t} where ts > now() - interval '30 days' group by 1`).join(" union all ")}) x group by d order by d desc`;
    const [s, d, party, plays, js, gfModes, gfTop] = await Promise.all([
      db.query(sum),
      db.query(perDay),
      db.query(`select ${DAY} d, count(*) filter (where type = 'party_create') created, count(*) filter (where type = 'party_join') joined,
          count(*) filter (where type = 'vote') votes, count(*) filter (where type = 'play') plays
        from party_events where ts > now() - interval '30 days' group by 1 order by 1 desc`),
      db.query(`select data->>'game' g, count(*) n, avg((data->>'members')::numeric) members, count(*) filter (where (data->>'vote')::bool) byVote
        from party_events where type = 'play' group by 1 order by 2 desc`),
      db.query(`select data->>'q' q, count(*) n, avg((data->>'yes')::numeric / nullif((data->>'players')::numeric, 0)) yes,
          avg((data->>'err')::numeric) err, sum((data->>'exact')::int)::numeric / nullif(sum((data->>'answered')::int), 0) exact
        from jasager_events where type = 'question' group by 1 order by 2 desc, 3 desc limit 60`),
      db.query(`select data->>'mode' m, count(*) n, avg((data->>'players')::numeric) players, avg((data->>'rounds')::numeric) rounds
        from gruenderfieber_events where type = 'game_start' group by 1 order by 2 desc`),
      db.query(`select ts, data from gruenderfieber_events where type = 'idea' order by (data->>'raised')::int desc, ts desc limit 40`),
    ]);
    const name = Object.fromEntries(games.map((g) => [g.id, g.name]));
    body += `<h2>Überblick (30 Tage)</h2>${table(["", "Geräte 24 h", "7 Tage", "30 Tage", "davon über Party", "Spiele", "zu Ende", "gerade online", "Peak"],
      s.rows.map((r, i) => [r.src, r.d1, r.d7, r.d30, i ? pct(r.viaparty, r.d30) : "–", i ? r.games : "–", i ? r.ended : "–", r.now ?? (i ? 0 : live.players), r.peak ?? "–"]))}
      <p class="note">Geräte: Website = Besucher der Startseite oder Party, Spiele = Leute, die einem Raum beigetreten sind. Party-Spieler zählen pro Party-Konto.</p>
      <h2>Pro Tag</h2>${table(["Tag", ...SOURCES.flatMap(([, n], i) => (i ? [`${n} Geräte`, "Spiele"] : ["Website Geräte"]))],
        d.rows.map((r) => [day(r.d), ...SOURCES.flatMap((_, i) => (i ? [r["p" + i] ?? 0, r["g" + i] ?? 0] : [r.p0 ?? 0]))]))}
      <h2>Parties</h2>${table(["Tag", "erstellt", "beigetreten", "Abstimmungen", "ins Spiel gewechselt"], party.rows.map((r) => [day(r.d), r.created, r.joined, r.votes, r.plays]))}
      <h2>Welche Spiele Parties spielen</h2>${table(["Spiel", "gestartet", "davon per Abstimmung", "Ø Leute"], plays.rows.map((r) => [name[r.g] || r.g, r.n, pct(r.byvote, r.n), num(r.members)]))}
      <h2>KONTEXTLOS</h2><p class="note">Vorlagen, Fragen und alle Posts: <a href="${esc(games.find((g) => g.id === "kontextlos")?.url || "")}/data">KONTEXTLOS-Daten</a> (dasselbe Passwort, falls dort gesetzt).</p>
      <h2>JA-SAGER: Fragen</h2>${table(["Frage", "gestellt", "Ø Ja", "Ø daneben", "genau getroffen"], js.rows.map((r) => [r.q, r.n, pct(r.yes, 1), num(r.err), pct(r.exact, 1)]))}
      <h2>GRÜNDERFIEBER: Modi</h2>${table(["Modus", "Spiele", "Ø Leute", "Ø Runden"], gfModes.rows.map((r) => [r.m, r.n, num(r.players), num(r.rounds)]))}
      <h2>GRÜNDERFIEBER: Erfindungen mit dem meisten Kapital</h2>${table(["Zeit", "Produkt", "Slogan", "Aufgabe", "Modus", "Kapital"],
        gfTop.rows.map((r) => [time(r.ts), r.data.product, r.data.slogan, [r.data.brief?.what, r.data.brief?.who, r.data.brief?.problem].filter(Boolean).join(" · "), r.data.mode, ((r.data.raised || 0) * 1000).toLocaleString("de-DE") + " €"]))}`;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FURIDA-Daten</title><meta name="robots" content="noindex">
<style>@font-face{font-family:"Brico";src:url("/fonts/BricolageGrotesque.ttf");font-weight:200 800;font-stretch:75% 100%}
:root{--bg:#0A0C17;--s:#151930;--s2:#1D2242;--line:rgba(200,210,255,.12);--text:#EEF0FF;--muted:#9AA0C3;--a1:#7C5CFF;--a2:#22D3EE}
*{box-sizing:border-box}html{background:var(--bg)}body{color:var(--text);font:500 15px/1.45 "Brico",system-ui,sans-serif;margin:0 auto;padding:16px 16px 48px;max-width:1200px}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(70% 60% at 0% 0%,rgba(124,92,255,.35),transparent 70%),radial-gradient(70% 60% at 100% 100%,rgba(34,211,238,.25),transparent 70%)}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:12px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.logo{font-weight:800;font-size:22px;letter-spacing:.14em;color:var(--text);text-decoration:none}.lbl{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:700}
h2{font-size:20px;font-weight:800;margin:28px 0 10px;letter-spacing:-.01em}.big{font-size:20px;font-weight:700}.big b{background:linear-gradient(100deg,var(--a1),var(--a2));padding:0 8px;border-radius:8px}
.note{color:var(--muted);font-size:14px;margin:8px 0 0}a{color:var(--a2)}
.w{overflow-x:auto;background:var(--s);border:1px solid var(--line);border-radius:14px}table{border-collapse:collapse;width:100%}
th,td{padding:7px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);white-space:nowrap}td:first-child{white-space:normal;min-width:140px}
th{background:var(--s2);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);position:sticky;top:0}tr:last-child td{border-bottom:0}</style>
<script>// refresh every 30 s without losing the scroll position
setInterval(async () => { try { const r = await fetch(location.href, { cache: "no-store" }); if (r.ok) { const d = new DOMParser().parseFromString(await r.text(), "text/html"); document.getElementById("d").replaceWith(d.getElementById("d")); } } catch {} }, 30000);</script>
<header><a class="logo" href="/">FURIDA</a><span class="lbl">Daten · Website und Spiele</span></header>
<div id="d"><p class="lbl">aktualisiert sich alle 30 s · Stand ${new Date().toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin" })}</p>${body}</div>`);
}

module.exports = { log, page };
