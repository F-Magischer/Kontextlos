// Party-enabled games. url: where players go (a *.furida.workers.dev worker, so it is same-site with the party).
// api: where this service calls the game backend (direct, skips the worker). key: shared secret for prepare/redeem.
module.exports = [
  {
    id: "kontextlos",
    name: "KONTEXTLOS",
    tag: "Sag was Harmloses – die anderen machen's schlimm.",
    max: 20,
    url: process.env.KONTEXTLOS_URL || "https://kontextlos.furida.workers.dev",
    api: process.env.KONTEXTLOS_API || process.env.KONTEXTLOS_URL || "https://kontextlos.onrender.com",
    key: process.env.KONTEXTLOS_KEY,
  },
];
