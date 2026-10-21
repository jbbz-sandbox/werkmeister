# GitHub Webhook Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub `pull_request` closed and `release` published events reach werkmeister through smee.io within seconds, and a shipped PR's session checks the feature for real against the published npm package.

**Architecture:** The dashboard server holds an SSE connection to a smee channel, verifies each event's GitHub signature, runs `watchPrs({desktop:false})`, then broadcasts a refresh signal on `GET /api/github/events`. The Claude Desktop plugin subscribes to that endpoint and runs its existing `callbackTick`/`prTick`. Polling is unchanged and stays the fallback. The release check is only new text in `callbackMessage`.

**Tech Stack:** TypeScript, Node 24 (`fetch`, `node:crypto`), Express 5, `node:test`, the `claude-code/testing` plugin harness. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-github-webhook-relay-design.md`

## Global Constraints

- No new dependencies: smee is read with `fetch` and a hand-written `text/event-stream` parser.
- Act only on `x-github-event` `pull_request` with action `closed`, and `release` with action `published`. Ignore everything else, including `ping`.
- Verify `x-hub-signature-256` (`sha256=<hex HMAC-SHA256 of the body with the secret>`) before acting. Bad or missing: log and drop.
- The relay starts only when a smee URL is configured **and** the dashboard binds loopback (`HOST` unset or `127.0.0.1`/`localhost`/`::1`). Never in a `HOST=0.0.0.0` container instance.
- Config, in the global config YAML (`loadConfig()`): `github_relay: { smee_url: string, secret: string }`.
- `/api/github/events` is loopback-only (`localOnly`), like `/api/session/stream`.
- Polling timers (`PR_POLL_MS`, `CALLBACK_POLL_MS`, the `pr watch` launchd job) are untouched.
- Webhook payloads are never stored or used as state. An event only triggers a refresh.
- `plugins/sandbox-tools/hooks/register.tsx` stays byte-identical to `plugins/werkmeister/hooks/register.tsx`.

## Review Focus

1. **smee drops or the dashboard restarts mid-stream.** Expect a reconnect with backoff and no crash or unhandled rejection. Covered by Task 2's reconnect test.
2. **A burst of events for one merge or release** (several deliveries within a second). Expect one `watchPrs` pass and one broadcast. Covered by Task 2's debounce test.
3. **`watchPrs` throws** (gh missing, malformed PR file). Expect the error logged and the broadcast still sent, so plugins still refresh. Covered by Task 3's test.
4. **The dashboard isn't running when Desktop starts, or stops later.** Expect the plugin to retry quietly, with no toast or log spam, and the timers keep working. Covered by Task 4's retry test.
5. **A chunk boundary splits an SSE frame** (from smee or from the dashboard). Expect frames reassembled before parsing. Covered by Task 1's parser test and Task 4's chunked-frame test.

---

### Task 1: Pure relay helpers (signature, event filter, SSE parser)

**Files:**
- Create: `apps/sandbox-dashboard/src/lib/github-relay.ts`
- Test: `apps/sandbox-dashboard/test/github-relay.smoke.mjs` (imports from `dist/lib/github-relay.js`, like `session-stream.smoke.mjs`)

**Interfaces:**
- Produces:
  - `type RelayEvent = { event: "pull_request" | "release"; repo: string }`
  - `verifySignature(body: string, signature: string | undefined, secret: string): boolean`: constant-time compare (`crypto.timingSafeEqual`), false on a missing or malformed header.
  - `relayEventOf(msg: SmeeMessage, secret: string): RelayEvent | null`, where `type SmeeMessage = Record<string, unknown> & { body?: unknown }`. smee puts lowercase GitHub headers at the top level and the parsed JSON in `body`. The signed body is `JSON.stringify(msg.body)`. Returns null on a bad signature, another event type, or another action. `repo` is `body.repository.full_name`.
  - `class SseParser { push(chunk: string): string[] }`: returns the `data:` payloads of every complete frame (frames end with a blank line, and multi-line `data:` joins with `\n`). Keeps a partial frame for the next push.

- [ ] **Step 1: Write the failing tests**

```js
const SECRET = "s3cret";
const sign = (body) => "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
const prBody = { action: "closed", pull_request: { merged: true }, repository: { full_name: "jbbz-sandbox/sandbox" } };
const msg = (event, body, sig = sign(JSON.stringify(body))) =>
  ({ "x-github-event": event, "x-hub-signature-256": sig, body });

// verifySignature
assert.equal(verifySignature('{"a":1}', sign('{"a":1}'), SECRET), true);
assert.equal(verifySignature('{"a":1}', sign('{"a":2}'), SECRET), false);
assert.equal(verifySignature('{"a":1}', undefined, SECRET), false);
assert.equal(verifySignature('{"a":1}', "sha256=zz", SECRET), false);

// relayEventOf
assert.deepEqual(relayEventOf(msg("pull_request", prBody), SECRET), { event: "pull_request", repo: "jbbz-sandbox/sandbox" });
assert.deepEqual(relayEventOf(msg("release", { ...prBody, action: "published" }), SECRET), { event: "release", repo: "jbbz-sandbox/sandbox" });
assert.equal(relayEventOf(msg("pull_request", { ...prBody, action: "opened" }), SECRET), null);
assert.equal(relayEventOf(msg("release", { ...prBody, action: "created" }), SECRET), null);
assert.equal(relayEventOf(msg("ping", prBody), SECRET), null);
assert.equal(relayEventOf(msg("pull_request", prBody, "sha256=" + "0".repeat(64)), SECRET), null);
assert.equal(relayEventOf({ "x-github-event": "pull_request", body: prBody }, SECRET), null);

// SseParser: split frames, multi-line data, comments/event lines ignored
const p = new SseParser();
assert.deepEqual(p.push('event: ready\ndata: {"a"'), []);
assert.deepEqual(p.push(':1}\n\ndata: x\ndata: y\n\n: keepalive\n\n'), ['{"a":1}', "x\ny"]);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build --workspace werkmeister-dashboard && node apps/sandbox-dashboard/test/github-relay.smoke.mjs`
Expected: FAIL, cannot find module `dist/lib/github-relay.js`.

- [ ] **Step 3: Implement the three exports in `apps/sandbox-dashboard/src/lib/github-relay.ts`**

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox-dashboard/src/lib/github-relay.ts apps/sandbox-dashboard/test/github-relay.smoke.mjs
git commit -m "feat(dashboard): verify and filter GitHub webhook events from smee"
```

### Task 2: smee connection with debounce and reconnect

**Files:**
- Modify: `apps/sandbox-dashboard/src/lib/github-relay.ts`
- Test: `apps/sandbox-dashboard/test/github-relay.smoke.mjs`

**Interfaces:**
- Consumes: Task 1's `SseParser` and `relayEventOf`.
- Produces: `startGithubRelay(opts: { url: string; secret: string; onEvents: (events: RelayEvent[]) => Promise<void>; debounceMs?: number /* 3000 */; backoffMs?: number[] /* [1000, 5000, 30000] */; fetch?: typeof fetch; log?: (line: string) => void }): { stop(): void }`
  - Reads `url` with `Accept: text/event-stream` and runs each `data:` payload through `JSON.parse` and `relayEventOf`. Parse errors are logged and skipped.
  - Collects accepted events and calls `onEvents` once, `debounceMs` after the first event of a burst. It never runs two `onEvents` at once: events that arrive during a call start the next burst.
  - When the stream ends or the fetch rejects, it logs and reconnects after `backoffMs[min(attempt, len-1)]`. The attempt count resets once a stream opens.
  - `stop()` aborts the fetch and clears timers.

- [ ] **Step 1: Write the failing tests** (a fake `fetch` returns a `Response` over a `ReadableStream` the test pushes chunks into)

```js
// debounce: three signed events in one burst → onEvents called once with all three
const calls = [];
const s1 = fakeStream();
const relay = startGithubRelay({ url: "https://smee.io/x", secret: SECRET, debounceMs: 20,
  fetch: async () => new Response(s1.readable), onEvents: async (ev) => { calls.push(ev); } });
for (let i = 0; i < 3; i++) s1.push(`data: ${JSON.stringify(msg("pull_request", prBody))}\n\n`);
s1.push(`data: ${JSON.stringify(msg("ping", prBody))}\n\n`);
s1.push("data: not json\n\n");
await sleep(60);
assert.equal(calls.length, 1);
assert.equal(calls[0].length, 3);
relay.stop();

// reconnect: first fetch rejects, second stream delivers → onEvents runs
let n = 0;
const s2 = fakeStream();
const got = [];
const r2 = startGithubRelay({ url: "https://smee.io/x", secret: SECRET, debounceMs: 5, backoffMs: [10],
  fetch: async () => { if (n++ === 0) throw new Error("down"); return new Response(s2.readable); },
  onEvents: async (ev) => { got.push(...ev); } });
await sleep(30);
s2.push(`data: ${JSON.stringify(msg("release", { ...prBody, action: "published" }))}\n\n`);
await sleep(30);
assert.equal(n, 2);
assert.deepEqual(got, [{ event: "release", repo: "jbbz-sandbox/sandbox" }]);
r2.stop();
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build --workspace werkmeister-dashboard && node apps/sandbox-dashboard/test/github-relay.smoke.mjs`
Expected: FAIL, `startGithubRelay is not a function`.

- [ ] **Step 3: Implement `startGithubRelay` as specified in Interfaces**

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: exits 0 and the process exits (no timers left after `stop()`).

- [ ] **Step 5: Commit**

```bash
git add apps/sandbox-dashboard/src/lib/github-relay.ts apps/sandbox-dashboard/test/github-relay.smoke.mjs
git commit -m "feat(dashboard): hold the smee channel with debounce and reconnect"
```

### Task 3: Wire the relay into the dashboard and serve `/api/github/events`

**Files:**
- Modify: `apps/sandbox-dashboard/src/lib/github-relay.ts` (the router and broadcast)
- Modify: `apps/sandbox-dashboard/src/main.ts` (start the relay when configured and loopback)
- Modify: `apps/sandbox-dashboard/README.md` (setup section)
- Test: `apps/sandbox-dashboard/test/github-relay.smoke.mjs`

**Interfaces:**
- Consumes: `startGithubRelay` (Task 2); `watchPrs` from `werkmeister-core/pr_lifecycle`; `loadConfig` from `werkmeister-core/config`; `localOnly` from `./localhost-form.js`.
- Produces:
  - `createGithubEventsRouter(): { router: Router; broadcast(events: RelayEvent[]): void }`. `GET /api/github/events` (with `localOnly`) sends SSE headers and a `: ok` comment, then one frame per broadcast: `data: {"events":[...],"at":<epoch ms>}\n\n`. A `: keepalive` comment goes out every 25 s. Subscribers are removed on `req` close.
  - `relayHandler(deps: { watchPrs: (o: { desktop: boolean }) => Promise<{ lines: string[] }>; broadcast: (e: RelayEvent[]) => void; log: (l: string) => void }): (events: RelayEvent[]) => Promise<void>`. Awaits `watchPrs({ desktop: false })` and logs its lines (or its error), then **always** broadcasts.
  - `main.ts`: reads `loadConfig().github_relay`. If `smee_url` and `secret` are both strings and `host` is loopback, it mounts the router, calls `startGithubRelay({ onEvents: relayHandler(...) })` and stops it in `shutdown`. Otherwise it mounts only the router (which stays idle) and starts no relay. Logs to stderr with the `[workspaces]` prefix, like the existing startup line.

- [ ] **Step 1: Write the failing tests**

```js
// relayHandler: watchPrs runs headless, then broadcast; broadcast still happens when watchPrs throws
const seen = [];
const h = relayHandler({ watchPrs: async (o) => { seen.push(["watch", o]); return { lines: ["app: merged"] }; },
  broadcast: (e) => seen.push(["broadcast", e]), log: () => {} });
await h([{ event: "pull_request", repo: "r" }]);
assert.deepEqual(seen, [["watch", { desktop: false }], ["broadcast", [{ event: "pull_request", repo: "r" }]]]);

const logs = []; const b = [];
await relayHandler({ watchPrs: async () => { throw new Error("gh missing"); },
  broadcast: (e) => b.push(e), log: (l) => logs.push(l) })([{ event: "release", repo: "r" }]);
assert.equal(b.length, 1);
assert.ok(logs.some((l) => l.includes("gh missing")));

// router: a subscriber on an ephemeral port receives one frame per broadcast
const { router, broadcast } = createGithubEventsRouter();
const app = express(); app.use(router);
const server = app.listen(0, "127.0.0.1");
const res = await fetch(`http://127.0.0.1:${server.address().port}/api/github/events`);
assert.equal(res.headers.get("content-type"), "text/event-stream");
broadcast([{ event: "release", repo: "r" }]);
const text = await readUntil(res.body, "\n\n", /data:/);
assert.match(text, /data: \{"events":\[\{"event":"release","repo":"r"\}\],"at":\d+\}/);
server.close();
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build --workspace werkmeister-dashboard && node apps/sandbox-dashboard/test/github-relay.smoke.mjs`
Expected: FAIL, `relayHandler is not a function`.

- [ ] **Step 3: Implement `createGithubEventsRouter` and `relayHandler`, then wire `main.ts` as specified**

- [ ] **Step 4: Add a "GitHub webhook relay" section to `apps/sandbox-dashboard/README.md`**

It covers: create a channel at https://smee.io/new; add `github_relay: { smee_url, secret }` to the global config (`openssl rand -hex 32` for the secret); add the repo webhook:

```bash
gh api repos/OWNER/REPO/hooks -f name=web -F active=true -f 'events[]=pull_request' -f 'events[]=release' -f config[url]=SMEE_URL -f config[content_type]=json -f config[secret]=SECRET
```

It also says the dashboard must be restarted to pick up the config, and that the polls still run without it.

- [ ] **Step 5: Run the dashboard's whole suite**

Run: `npm test --workspace werkmeister-dashboard`
Expected: every smoke test exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/sandbox-dashboard/src apps/sandbox-dashboard/test/github-relay.smoke.mjs apps/sandbox-dashboard/README.md
git commit -m "feat(dashboard): relay GitHub events to watchPrs and /api/github/events"
```

### Task 4: Desktop plugin subscribes to the dashboard's events

**Files:**
- Modify: `plugins/werkmeister/hooks/register.tsx` (near `startCallbacks`, line ~1369)
- Copy to: `plugins/sandbox-tools/hooks/register.tsx` (byte-identical)
- Test: `plugins/werkmeister/hooks/register.test.ts`

**Interfaces:**
- Consumes: the `/api/github/events` frame format from Task 3; the existing `callbackTick($)`, `prTick($)` and `timers`.
- Produces:
  - `export const GITHUB_EVENTS_URL = "http://127.0.0.1:3001/api/github/events"`
  - `export const GITHUB_RETRY_MS = 30000`
  - `startGithubEvents($: EngineInterface): void`, called from `startCallbacks` (so desktop only). It runs a background loop: `$.process.spawn({ argv: ["curl", "-sN", "--fail", GITHUB_EVENTS_URL] })`. On every complete `data:` frame (frames buffered across chunks) it runs `void callbackTick($)`, plus `void prTick($)` when `timers.length > 0` (the pane is polling). When the child ends or fails to start, it waits `GITHUB_RETRY_MS` (`$.clock.sleep`) and respawns. Calling it again cancels the previous loop, the same guard `startCallbacks` uses for its timer. It never toasts. A failure goes to `$.ui.log(..., { to: "debug" })` only.

- [ ] **Step 1: Write the failing tests** (next to the existing "a desktop session runs the PR callback pass…" test; stub `process.spawn` with `on("process.spawn", async function* () { … })`)

```ts
test("a desktop session runs the PR callback pass on each dashboard GitHub event", async ($, on) => {
  const w = world(on, { [`${WS}/pr-watch`]: () => ok({ ok: true, lines: [], desktop: [] }) });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", () => ({ value: [] }));
  on("fs.exists", () => ({ value: false }));
  const spawned: string[][] = [];
  on("process.spawn", async function* (_$, e) {
    spawned.push([...e.argv]);
    yield { stream: "stdout", text: ": ok\n\ndata: {\"events\":[{\"event\":\"pull_request\",\"repo\":\"r\"}]," };
    yield { stream: "stdout", text: "\"at\":1}\n\n" };
    yield { code: 0, signal: null };
  });
  const passes = () => w.calls.filter((c) => c.key === `${WS}/pr-watch`).length;
  await $.session.start({ cwd: "/elsewhere", surface: "desktop", isInteractive: true });
  await w.clock.advance(0);
  expect(spawned[0]).toEqual(["curl", "-sN", "--fail", GITHUB_EVENTS_URL]);
  expect(passes()).toBe(2); // start pass + one for the split frame
  await w.clock.advance(GITHUB_RETRY_MS);
  expect(spawned.length).toBe(2); // respawned after the stream ended
});

test("a terminal session never subscribes to dashboard GitHub events", async ($, on) => {
  world(on);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", () => ({ value: [] }));
  on("fs.exists", () => ({ value: false }));
  let spawns = 0;
  on("process.spawn", async function* () { spawns++; yield { code: 7, signal: null }; });
  await $.session.start({ cwd: "/elsewhere", surface: "terminal", isInteractive: true });
  expect(spawns).toBe(0);
});
```

Adjust the stub's yield shapes to the harness's exact `process.spawn` piece types in `plugins/werkmeister/.claude-plugin/types/claude-code/index.d.ts` if they differ. The assertions stay as written.

- [ ] **Step 2: Run to verify it fails**

The plugin isn't an npm workspace, and no repo script runs `register.test.ts`. Find the `claude-code/testing` runner with `claude plugin --help`, run it on `plugins/werkmeister`, and use that same command in Step 4.
Expected: FAIL, `GITHUB_EVENTS_URL` is not exported.

- [ ] **Step 3: Implement `startGithubEvents` as specified, call it from `startCallbacks`, then `cp plugins/werkmeister/hooks/register.tsx plugins/sandbox-tools/hooks/register.tsx`**

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: PASS, including the existing callback-timer test (its pass counts must not change). If they do change because the spawn stub is missing there, add `on("process.spawn", async function* () { yield { code: 7, signal: null }; })` to that test's world rather than changing its expectations.

- [ ] **Step 5: Commit**

```bash
git add plugins/werkmeister/hooks/register.tsx plugins/werkmeister/hooks/register.test.ts plugins/sandbox-tools/hooks/register.tsx
git commit -m "feat(werkmeister): run the PR callback pass on dashboard GitHub events"
```

### Task 5: Release check in the shipped callback message

**Files:**
- Modify: `packages/sandbox-core/src/pr_lifecycle.ts:882-889` (`callbackMessage`)
- Test: `packages/sandbox-core/pr-lifecycle.test.mjs:1218` ("callbackMessage: the issue's texts")

**Interfaces:**
- Produces: `callbackMessage(status: string, url: string, release?: string): string | null` (same signature). Only `shipped` **with** a `release` changes. `shipped` without a release keeps today's text exactly.

- [ ] **Step 1: Update the test to the spec's exact copy**

```js
assert.equal(
  callbackMessage("shipped", URL9, "v1.2.0"),
  `PR ${URL9} shipped in v1.2.0. If nothing this PR changed ships in the published package, say so, ` +
    "skip the release check, and ask the person whether to run `sandbox close-out`. Otherwise, check it's live: " +
    "in a fresh temp directory (not the repo checkout), install the released version the way a user gets it " +
    "(if it isn't installable yet, wait for it for up to ~10 minutes before calling that a FAIL), and redo the " +
    "checks from this PR's exercise.md against that install. Add a \"Release check\" section to exercise.md with " +
    "its own PASS/FAIL table; mark checks that only make sense in the local sandbox (containers, test commands) " +
    "N/A. All PASS: ask the person whether to run `sandbox close-out`. Any FAIL: stop and tell the person. " +
    "They'll check the release by hand and restart this agent.",
);
assert.equal(
  callbackMessage("shipped", URL9),
  `PR ${URL9} shipped. Ask the person whether to run \`sandbox close-out\`.`,
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build --workspace werkmeister-core && cd packages/sandbox-core && node --test --test-name-pattern="callbackMessage" pr-lifecycle.test.mjs`
Expected: FAIL on the `v1.2.0` assertion.

- [ ] **Step 3: Implement the new `shipped`-with-release text in `callbackMessage`**

- [ ] **Step 4: Run the core suite**

Run: `npm test --workspace werkmeister-core`
Expected: PASS. Other tests that pin the shipped text (search `shipped in` in `*.test.mjs`) are updated to the new copy, with no other change to their expectations.

- [ ] **Step 5: Add a changeset and commit**

Run `npx changeset` and choose `werkmeister-core: minor` with the summary "The shipped PR callback asks the session to verify the release against the published package." Also add `werkmeister-dashboard`/plugin entries if the repo's changeset config covers them.

```bash
git add packages/sandbox-core/src/pr_lifecycle.ts packages/sandbox-core/pr-lifecycle.test.mjs .changeset
git commit -m "feat(core): verify the published release from the shipped PR callback"
```

### Task 6: Live check against smee and GitHub (manual, with the person)

**Files:** none (configuration only, outside the repo)

- [ ] **Step 1: Ask the person to create the smee channel, the config entry and the webhook,** following the README section from Task 3. Do not create the webhook or the secret on their behalf without their go-ahead: it changes the GitHub repo's settings.

- [ ] **Step 2: Restart the dashboard and confirm it logs that the relay connected.**

- [ ] **Step 3: Check that signatures survive smee.** Redeliver a recent `pull_request` delivery from the webhook's "Recent deliveries" page (or `gh api -X POST repos/OWNER/REPO/hooks/HOOK_ID/deliveries/ID/attempts`). Expected: the dashboard logs a `watchPrs` pass and no signature failure.

If the signature fails, stop and report to the person (spec: "stop and raise it"). Don't loosen verification in this plan.

- [ ] **Step 4: With a Desktop session open, confirm a redelivered event triggers a `pr-watch` pass** within a few seconds (the werkmeister debug log, or the workspace card's PR line refreshing).
