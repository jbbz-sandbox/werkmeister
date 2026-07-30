// Smoke test for lib/session-stream: backfill-then-tail + index-addressed
// live deltas, driven against a fabricated workspace + Claude project dir.
//   npm run build && node lib/session-stream.smoke.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sstream-"));
const home = path.join(tmp, "home");
const wsRoot = path.join(tmp, "workspaces");
const wsPath = path.join(wsRoot, "demo");
fs.mkdirSync(wsPath, { recursive: true });

process.env.HOME = home;
process.env.SANDBOX_WORKSPACES_ROOT = wsRoot;

// Claude encodes the project dir as workspacePath with every non-alphanumeric → "-".
const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, "-");
const projDir = path.join(home, ".claude", "projects", encoded);
fs.mkdirSync(projDir, { recursive: true });
const sessionFile = path.join(projDir, "abc123.jsonl");

const line = (o) => JSON.stringify(o) + "\n";
const userLine = (t) => line({ type: "user", timestamp: "2026-07-10T00:00:00Z", message: { role: "user", content: t } });
const asstLine = (t) => line({ type: "assistant", timestamp: "2026-07-10T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: t }] } });

// Pre-existing history → must arrive as backfill.
fs.writeFileSync(sessionFile, userLine("hello") + asstLine("hi there"));

const { subscribeSession } = await import(path.join(pkgRoot, "dist/lib/session-stream.js"));

const events = [];
let ready = false;
const unsub = subscribeSession("demo", (e) => {
  events.push(e);
  if (e.type === "ready") ready = true;
});

const waitFor = (pred, ms = 5000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("timeout: " + JSON.stringify(events))); }
    }, 50);
  });

// 1. Backfill: two entries then ready.
await waitFor(() => ready);
const backfill = events.filter((e) => e.type === "entry");
assert.equal(backfill.length, 2, "expected 2 backfill entries");
assert.deepEqual(backfill.map((e) => e.index), [0, 1], "backfill indices contiguous from 0");
assert.equal(backfill[0].message.role, "user");
assert.equal(backfill[0].message.text, "hello");
assert.equal(backfill[1].message.text, "hi there");
console.log("✓ backfill: 2 entries + ready");

// 2. Live append → a new index-3rd entry delta (fs.watch, or safety re-read).
const before = events.length;
fs.appendFileSync(sessionFile, asstLine("a follow-up"));
await waitFor(() => events.some((e, i) => i >= before && e.type === "entry" && e.index === 2));
const live = events.slice(before).find((e) => e.type === "entry" && e.index === 2);
assert.equal(live.message.text, "a follow-up", "live entry text");
console.log("✓ live append delivered as entry index 2");

unsub();

// 3. "waiting for input" signal: no tracked turn + Claude spoke last → waiting.
const { getWorkspaceStatuses } = await import("sandbox-driver");
const { statuses } = await getWorkspaceStatuses();
const demo = statuses.find((s) => s.name === "demo");
assert.ok(demo, "demo workspace in status sweep");
assert.equal(demo.claude.state, "idle", "no server-tracked turn → idle");
assert.equal(demo.claude.waiting, true, "assistant spoke last → waiting for input");

// Flip it: append a user line → Claude no longer spoke last → not waiting.
fs.appendFileSync(sessionFile, userLine("another question"));
const { statuses: s2 } = await getWorkspaceStatuses();
assert.equal(s2.find((s) => s.name === "demo").claude.waiting, false, "user spoke last → not waiting");
console.log("✓ waiting-for-input signal: true after assistant, false after user");

// 4. Resume cursor: a reconnect from index N skips the backfill it already has.
// File now holds 4 entries (user, asst, asst, user). Resume from index 2.
const ev2 = [];
let ready2 = false;
const unsub2 = subscribeSession("demo", (e) => { ev2.push(e); if (e.type === "ready") ready2 = true; }, 2);
await waitFor(() => ready2);
assert.deepEqual(
  ev2.filter((e) => e.type === "entry").map((e) => e.index),
  [2, 3],
  "resume from index 2 skips entries 0–1",
);
unsub2();
console.log("✓ resume cursor: backfill starts at fromIndex, earlier entries skipped");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL PASS");
process.exit(0);
