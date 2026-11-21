// Party-enabled games. url: where players go (a *.furida.workers.dev worker, so it is same-site with the party).
// api: where this service calls the game backend (direct, skips the worker). key: shared secret for prepare/redeem.
// art: wallpaper in public/games/, shown in the hub's library.
module.exports = [
  {
    id: "kontextlos",
    name: "KONTEXTLOS",
    tag: "Sag was Harmloses – die anderen machen's schlimm.",
    desc: "Ihr beantwortet harmlose Fragen. Dann verdreht jemand anderes eure Antwort in einen völlig neuen Zusammenhang – Polizeiverhör, Werbespot, Chat mit Mama. Die schlimmste Version gewinnt.",
    players: "2–20",
    time: "15–25 Min.",
    tags: ["Party", "Kreativ", "Handy + TV"],
    art: "/games/kontextlos.svg",
    max: 20,
    url: process.env.KONTEXTLOS_URL || "https://kontextlos.furida.workers.dev",
    api: process.env.KONTEXTLOS_API || process.env.KONTEXTLOS_URL || "https://kontextlos.onrender.com",
    key: process.env.KONTEXTLOS_KEY,
  },
  {
    id: "jasager",
    name: "JA-SAGER",
    tag: "Ja oder Nein – und wie viele von euch sagen Ja?",
    desc: "Alle beantworten dieselbe persönliche Frage ehrlich mit Ja oder Nein. Dann dreht jeder am Zahlenrad: Wie viele aus der Runde haben Ja gesagt? Genau richtig gibt 3 Punkte, knapp daneben 1.",
    players: "2–20",
    time: "10–20 Min.",
    tags: ["Party", "Schätzen", "Nur Handy"],
    art: "/games/jasager.svg",
    max: 20,
    url: process.env.JASAGER_URL || "https://jasager.furida.workers.dev",
    api: process.env.JASAGER_API || process.env.JASAGER_URL || "https://jasager.onrender.com",
    key: process.env.JASAGER_KEY,
  },
];
