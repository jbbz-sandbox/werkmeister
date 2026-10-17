// Smoke test for lib/browser-ui launchBrowserUi: when the dashboard port is
// already taken, it REUSES that server (opens the browser to it) instead of
// spawning a second one on a random port — the fix that pins the dashboard to
// one URL. Run: npm run build && node lib/browser-ui.smoke.mjs
import assert from "node:assert";
import http from "node:http";

const PORT = 3017; // a throwaway test port, not the real 3001 dashboard
process.env.PORT = String(PORT); // read once at module load as DASHBOARD_PORT

// Stand in for a dashboard already bound to the port (the durable server, or
// another session). launchBrowserUi must find this and reuse it.
const squatter = http.createServer((_req, res) => res.end("ok"));
await new Promise((r) => squatter.listen(PORT, "127.0.0.1", r));

const { launchBrowserUi } = await import("../dist/lib/browser-ui.js");

// open:false so no browser launches in CI. Must resolve (not reject on
// EADDRINUSE) with the canonical URL, and must NOT have started a 2nd listener.
const { url } = await launchBrowserUi({ open: false });
assert.equal(url, `http://127.0.0.1:${PORT}/`, "reused URL should be the pinned port");

// The squatter is still the one serving the port — no second server took over.
const body = await new Promise((resolve, reject) => {
  http
    .get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    })
    .on("error", reject);
});
assert.equal(body, "ok", "port must still be served by the pre-existing server");

squatter.close();
console.log("browser-ui smoke: PASS (reuses existing server on the pinned port)");
process.exit(0);
