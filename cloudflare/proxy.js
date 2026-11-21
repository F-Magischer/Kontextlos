// Cloudflare Worker: serves a Render app under <name>.furida.workers.dev, so all party sites are same-site.
// Passes every request through unchanged, WebSocket upgrades included. Set the variable TARGET, e.g. kontextlos.onrender.com
export default {
  fetch(req, env) {
    const url = new URL(req.url);
    url.hostname = env.TARGET;
    return fetch(new Request(url, req));
  },
};
