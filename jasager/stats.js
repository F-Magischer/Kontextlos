// Play data: events go to Postgres (the same Neon database as KONTEXTLOS, own table) when DATABASE_URL is set, else nowhere.
// The overview of all games is on play.furida.workers.dev/data.
const TABLE = "jasager_events";
const db = process.env.DATABASE_URL ? new (require("pg").Pool)({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } }) : null;
const ready = db
  ? db.query(`create table if not exists ${TABLE} (id bigserial primary key, ts timestamptz not null default now(), type text not null, room text, dev text, data jsonb);
      create index if not exists ${TABLE}_type_ts on ${TABLE} (type, ts);`).catch((e) => console.error("stats: setup failed", e.message))
  : Promise.resolve();

// fire and forget: the game never waits for or fails on the database
function log(type, room, dev, data) {
  if (!db) return;
  ready.then(() => db.query(`insert into ${TABLE} (type, room, dev, data) values ($1,$2,$3,$4)`, [type, room || null, dev || null, data || null]))
    .catch((e) => console.error("stats:", e.message));
}

module.exports = { log };
