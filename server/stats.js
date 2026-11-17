// Play data for improving the game: events go to Postgres (Neon) when DATABASE_URL is set, else nowhere.
// /data shows them behind DATA_PASSWORD (HTTP Basic auth; any user name).
const crypto = require("crypto");

const db = process.env.DATABASE_URL ? new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, max: 3, ssl: { rejectUnauthorized: false } }) : null;
const ready = db
  ? db.query(`create table if not exists events (id bigserial primary key, ts timestamptz not null default now(), type text not null, room text, dev text, data jsonb);
      create index if not exists events_type_ts on events (type, ts);`).catch((e) => console.error("stats: setup failed", e.message))
  : Promise.resolve();

// fire and forget: the game never waits for or fails on the database
function log(type, room, dev, data) {
  if (!db) return;
  ready.then(() => db.query("insert into events (type, room, dev, data) values ($1,$2,$3,$4)", [type, room || null, dev || null, data || null]))
    .catch((e) => console.error("stats:", e.message));
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DAY = "(ts at time zone 'Europe/Berlin')::date";

function authed(req) {
  const pw = process.env.DATA_PASSWORD;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!pw || !m) return false;
  const given = Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":");
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

const table = (head, rows) => `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${head.length}">noch nichts</td></tr>`}</table>`;
const pct = (n, d) => (d ? Math.round((100 * n) / d) + " %" : "–");

async function page(req, res, live) {
  if (!process.env.DATA_PASSWORD) return res.writeHead(404).end("not found");
  if (!authed(req)) return res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Kontextlos-Daten"' }).end("Passwort nötig");
  const q = new URL(req.url, "http://x").searchParams.get("q") || "";
  let body = `<p class="big">Gerade online: <b>${live.players}</b> Spieler in <b>${live.rooms}</b> Räumen</p>`;
  if (!db) body += "<p>Keine DATABASE_URL gesetzt, es wird nichts gespeichert.</p>";
  else {
    await ready;
    const [days, ret, fmts, prompts, posts] = await Promise.all([
      db.query(`select ${DAY} d, count(distinct dev) filter (where type='join') spieler, count(distinct room) filter (where type='join') raeume,
          count(*) filter (where type='game_start') spiele, count(*) filter (where type='game_end') fertig, max((data->>'players')::int) filter (where type='ccu') peak
        from events where ts > now() - interval '30 days' group by 1 order by 1 desc`),
      db.query(`with s as (select distinct dev, ${DAY} d from events where type='join' and dev <> ''), f as (select dev, min(d) d0 from s group by dev)
        select d0, count(*) neu, count(*) filter (where exists (select 1 from s where s.dev=f.dev and s.d=f.d0+1)) d1,
          count(*) filter (where exists (select 1 from s where s.dev=f.dev and s.d=f.d0+7)) d7 from f group by d0 order by d0 desc limit 30`),
      db.query(`select data->>'fmt' f, count(*) n, avg((data->>'votes')::numeric) votes, count(*) filter (where (data->>'noTwist')::bool) leer, avg(length(data->>'twist')) len
        from events where type='post' group by 1 order by 3 desc`),
      db.query(`select data->>'prompt' p, count(*) n, count(*) filter (where (data->>'noAnswer')::bool) leer, avg((data->>'votes')::numeric) votes
        from events where type='post' group by 1 order by 3 desc, 2 desc limit 40`),
      db.query(`select ts, room, data from events where type='post' and ($1 = '' or data::text ilike '%' || $1 || '%') order by ts desc limit 200`, [q]),
    ]);
    const n = (v, dig = 1) => (v == null ? "–" : Number(v).toFixed(dig));
    body += `<h2>Pro Tag (30 Tage)</h2>${table(["Tag", "Geräte", "Räume", "Spiele", "zu Ende", "Peak-CCU"], days.rows.map((r) => [r.d.toISOString().slice(0, 10), r.spieler, r.raeume, r.spiele, r.fertig, r.peak ?? "–"]))}
      <h2>Retention (nach erstem Tag)</h2>${table(["Erster Tag", "Neue Geräte", "D1", "D7"], ret.rows.map((r) => [r.d0.toISOString().slice(0, 10), r.neu, pct(r.d1, r.neu), pct(r.d7, r.neu)]))}
      <h2>Vorlagen</h2>${table(["Vorlage", "Posts", "Ø Stimmen", "Timer leer", "Ø Zeichen"], fmts.rows.map((r) => [r.f, r.n, n(r.votes, 2), pct(r.leer, r.n), n(r.len, 0)]))}
      <h2>Fragen (meiste leere Antworten zuerst)</h2>${table(["Frage", "gestellt", "leer", "Ø Stimmen"], prompts.rows.map((r) => [r.p, r.n, pct(r.leer, r.n), n(r.votes, 2)]))}
      <h2>Protokoll (letzte 200 Posts)</h2><form><input name="q" value="${esc(q)}" placeholder="Text suchen"> <button>Suchen</button></form>
      ${table(["Zeit", "Raum", "Vorlage", "Frage", "Antwort", "Twist", "Stimmen"], posts.rows.map((r) => [r.ts.toISOString().slice(0, 16).replace("T", " "), r.room, r.data.fmt, r.data.prompt, r.data.answer, r.data.twist, r.data.votes]))}`;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kontextlos – Daten</title>
<style>@font-face{font-family:"Brico";src:url("/fonts/BricolageGrotesque.ttf");font-weight:200 800;font-stretch:75% 100%}
html{background:#EFE7D6 radial-gradient(rgba(27,26,23,.13) 1px,transparent 1.2px) 0 0/7px 7px fixed}
body{color:#1B1A17;font:500 16px/1.4 "Brico",system-ui,sans-serif;font-stretch:90%;margin:0 auto;padding:14px 18px 40px;max-width:1200px;position:relative;z-index:1}
html::before,html::after{content:"";position:fixed;width:360px;height:48px;transform:rotate(-24deg);opacity:.92;pointer-events:none}
html::before{background:#FF4F79;left:-90px;bottom:60px}html::after{background:#2B59C3;right:-110px;top:140px}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1B1A17;padding-bottom:10px;margin-bottom:20px}
.logo{font-weight:800;font-size:26px;color:#1B1A17;text-decoration:none;letter-spacing:-.02em}.logo span{background:#1B1A17;color:#EFE7D6;padding:1px 7px;margin-right:3px;box-shadow:3px 3px 0 #FF4F79}
.lbl,th{font-weight:700;font-stretch:78%;letter-spacing:.08em;text-transform:uppercase;font-size:13px}
h2{font-weight:800;font-size:24px;background:#2B59C3;color:#fff;display:inline-block;padding:4px 12px;margin:30px 0 10px;box-shadow:4px 4px 0 #1B1A17;transform:rotate(-1deg)}
.big{font-size:22px;font-weight:700}.big b{background:#FFD23F;padding:0 8px;border:3px solid #1B1A17}div.w{overflow-x:auto;box-shadow:6px 6px 0 #1B1A17;background:#FFFDF7;border:3px solid #1B1A17}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid rgba(27,26,23,.3);padding:6px 10px;text-align:left;vertical-align:top}th{background:#FF4F79;color:#fff}
input{font:inherit;padding:8px;border:3px solid #1B1A17;background:#FFFDF7}button{font:800 16px "Brico",sans-serif;padding:8px 14px;border:3px solid #1B1A17;background:#1B1A17;color:#EFE7D6;box-shadow:4px 4px 0 #FF4F79;cursor:pointer}form{margin-bottom:12px}</style>
<script>// refresh every 30 s without losing scroll position or a search being typed
setInterval(async () => { if (document.activeElement.tagName === "INPUT") return;
  try { const r = await fetch(location.href, { cache: "no-store" }); if (r.ok) { const d = new DOMParser().parseFromString(await r.text(), "text/html"); document.getElementById("d").replaceWith(d.getElementById("d")); } } catch {} }, 30000);</script>
<header><a class="logo" href="/"><span>KONTEXT</span>LOS</a><span class="lbl">Spieldaten</span></header><div id="d"><p class="lbl" style="opacity:.6">aktualisiert sich alle 30 s · Stand ${new Date().toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin" })}</p>${body.replace(/<table>/g, '<div class="w"><table>').replace(/<\/table>/g, "</table></div>")}</div>`);
}

module.exports = { log, page };
