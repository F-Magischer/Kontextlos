// Cloudflare Worker: serves a Render app under <name>.furida.workers.dev, so all party sites are same-site.
// Passes every request through unchanged, WebSocket upgrades included. Set the variable TARGET, e.g. kontextlos.onrender.com
// While the free Render server sleeps, pages get our own loading screen (instead of Render's) that reloads once it is up.
const NAMES = { kontextlos: "KONTEXTLOS", jasager: "JA-SAGER", gruenderfieber: "GRÜNDERFIEBER", play: "FURIDA" };
let awakeUntil = 0; // per worker instance: after a good answer, skip the check for a minute

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const name = NAMES[url.hostname.split(".")[0]] || "FURIDA";
    url.hostname = env.TARGET;
    if (url.pathname === "/__wake") return Response.json({ up: await up(env.TARGET) }, { headers: { "cache-control": "no-store" } });
    const page = req.method === "GET" && !req.headers.get("upgrade") && (req.headers.get("sec-fetch-mode") === "navigate" || (req.headers.get("accept") || "").includes("text/html"));
    if (page && Date.now() > awakeUntil && !(await up(env.TARGET)))
      return new Response(loading(name), { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "5" } });
    return fetch(new Request(url, req));
  },
};

// every request wakes a sleeping Render server; it answers "ok" on /health once it is running
async function up(host) {
  try {
    const r = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(4000), redirect: "manual" });
    const ok = r.ok && (await r.text()).trim() === "ok";
    if (ok) awakeUntil = Date.now() + 60000;
    return ok;
  } catch { return false; }
}

const loading = (name) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} startet …</title><meta name="theme-color" content="#0E0F1A">
<style>
* { box-sizing: border-box; margin: 0; }
body { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #0E0F1A; color: #EEF0FF; font: 600 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  background-image: radial-gradient(60% 60% at 0% 0%, rgba(124,92,255,.45), transparent), radial-gradient(60% 60% at 100% 100%, rgba(34,211,238,.35), transparent); }
main { width: min(440px, 100%); display: grid; gap: 14px; text-align: center; }
.brand { font-weight: 800; font-size: 13px; letter-spacing: .3em; opacity: .7; }
h1 { font-size: clamp(30px, 9vw, 44px); line-height: 1.05; letter-spacing: -.02em; font-weight: 800; overflow-wrap: anywhere; }
.track { height: 12px; border-radius: 99px; background: rgba(255,255,255,.12); overflow: hidden; margin-top: 10px; }
.track i { display: block; height: 100%; width: 2%; border-radius: inherit; background: linear-gradient(90deg, #7C5CFF, #22D3EE); transition: width .3s linear; }
p { opacity: .75; font-size: 15px; } #left { font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .track i { transition: none; } }
</style></head><body><main>
<span class="brand">FURIDA</span><h1>${name} wird hochgefahren</h1>
<div class="track" role="progressbar" aria-label="Server startet"><i id="bar"></i></div>
<p id="left">noch ca. 50 s</p>
<p>Der Server hat geschlafen, weil eine Weile niemand gespielt hat. Die Seite lädt von selbst neu, sobald er bereit ist.</p>
</main><script>
const t0 = Date.now(), ETA = 50;
setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  document.getElementById("bar").style.width = (t < ETA ? 2 + t / ETA * 83 : 85 + 13 * (1 - Math.exp(-(t - ETA) / 40))).toFixed(1) + "%";
  document.getElementById("left").textContent = t < ETA - 3 ? "noch ca. " + Math.ceil(ETA - t) + " s" : "gleich geschafft …";
}, 250);
(async function poll() {
  try { if ((await (await fetch("/__wake", { cache: "no-store" })).json()).up) { document.getElementById("bar").style.width = "100%"; return location.reload(); } } catch {}
  setTimeout(poll, 2500);
})();
</script></body></html>`;
