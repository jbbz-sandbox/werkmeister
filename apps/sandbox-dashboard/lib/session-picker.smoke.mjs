// Smoke test for the session picker: listSessions() labelling/ordering,
// sessionId-pinned transcript/source resolution (with stale-id fallback), and
// a pinned tailer that does NOT follow session rolls.
//   npm run build && node lib/session-picker.smoke.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spicker-"));
const home = path.join(tmp, "home");
const wsRoot = path.join(tmp, "workspaces");
const wsPath = path.join(wsRoot, "demo");
fs.mkdirSync(wsPath, { recursive: true });
process.env.HOME = home;
process.env.SANDBOX_WORKSPACES_ROOT = wsRoot;

const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, "-");
const projDir = path.join(home, ".claude", "projects", encoded);
fs.mkdirSync(projDir, { recursive: true });

const line = (o) => JSON.stringify(o) + "\n";
const userLine = (t) => line({ type: "user", timestamp: "2026-07-10T00:00:00Z", message: { role: "user", content: t } });
const asstLine = (t) => line({ type: "assistant", timestamp: "2026-07-10T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const titleLine = (id, t) => line({ type: "ai-title", sessionId: id, aiTitle: t });

// Three sessions with controlled mtimes so ordering is deterministic.
const A = "aaaaaaaa-0000-0000-0000-000000000001"; // newest, has ai-title
const B = "bbbbbbbb-0000-0000-0000-000000000002"; // middle, first-user fallback
const C = "cccccccc-0000-0000-0000-000000000003"; // oldest, uuid fallback (no title, no user)
const fileOf = (id) => path.join(projDir, id + ".jsonl");
const write = (id, body, mtimeSec) => {
  fs.writeFileSync(fileOf(id), body);
  fs.utimesSync(fileOf(id), mtimeSec, mtimeSec);
};
write(C, asstLine("orphan assistant"), 100);
write(B, userLine("do the important thing") + asstLine("on it"), 200);
write(A, titleLine(A, "Newest Session Title") + userLine("hi") + asstLine("hello"), 300);

const { listSessions, getClaudeTranscript, resolveSessionSource } =
  await import("sandbox-core");

// 1. listSessions: newest first, isNewest flag, three-tier title fallback.
const sessions = await listSessions("demo");
assert.deepEqual(sessions.map((s) => s.sessionId), [A, B, C], "newest mtime first");
assert.deepEqual(sessions.map((s) => s.isNewest), [true, false, false], "only [0] isNewest");
assert.equal(sessions[0].title, "Newest Session Title", "ai-title used when present");
assert.equal(sessions[1].title, "do the important thing", "first user message when no ai-title");
assert.equal(sessions[2].title, C.slice(0, 8), "uuid8 fallback when no title/user msg");
assert.ok(sessions[0].updatedAt, "updatedAt present");
console.log("✓ listSessions: order, isNewest, ai-title → first-user → uuid8 fallback");

// 2. getClaudeTranscript honours an explicit older sessionId.
const tB = await getClaudeTranscript("demo", 20, B);
assert.equal(tB.sessionId, B, "pinned to B");
assert.ok(tB.messages.some((m) => m.text === "do the important thing"), "B's content");

// 3. Stale id → fall back to newest, no throw.
const tStale = await getClaudeTranscript("demo", 20, "deadbeef-0000-0000-0000-000000000000");
assert.equal(tStale.sessionId, A, "unknown id falls back to newest");
console.log("✓ getClaudeTranscript: pins to given session; stale id → newest");

// 4. resolveSessionSource pins the named file.
const srcB = await resolveSessionSource("demo", B);
assert.equal(srcB.sessionFile, fileOf(B), "resolveSessionSource pins B");
const srcDefault = await resolveSessionSource("demo");
assert.equal(srcDefault.sessionFile, fileOf(A), "no id → newest");
console.log("✓ resolveSessionSource: pins named file, defaults to newest");

// 5. Pinned tailer does NOT follow a session roll; unpinned one does.
const { subscribeSession } = await import(path.join(pkgRoot, "dist/lib/session-stream.js"));
const waitFor = (pred, ms = 4000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("timeout")); }
    }, 40);
  });

const pinnedEvents = [];
let pinnedReady = null;
const unsubPinned = subscribeSession("demo", (e) => {
  pinnedEvents.push(e);
  if (e.type === "ready") pinnedReady = e;
}, 0, B);
await waitFor(() => pinnedReady);
assert.equal(pinnedReady.sessionId, B, "pinned ready reports B");

// A brand-new newest session appears + gets appended to.
const D = "dddddddd-0000-0000-0000-000000000004";
write(D, userLine("started elsewhere"), 400);
fs.appendFileSync(fileOf(D), asstLine("external reply"));
// Give the dir/file watchers + safety re-read time to (not) switch.
await new Promise((r) => setTimeout(r, 400));
assert.ok(
  !pinnedEvents.some((e) => e.type === "entry" && e.message.text === "external reply"),
  "pinned stream must NOT pull in the rolled-to session's content",
);
unsubPinned();
console.log("✓ pinned tailer ignores session rolls");

const followEvents = [];
let followReady = null;
const unsubFollow = subscribeSession("demo", (e) => {
  followEvents.push(e);
  if (e.type === "ready") followReady = e;
});
await waitFor(() => followReady);
assert.equal(followReady.sessionId, D, "unpinned ready reports newest (D)");
unsubFollow();
console.log("✓ unpinned tailer follows to newest");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL PASS");
process.exit(0);
