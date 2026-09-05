# `apps/mcp` Remote MCP Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/mcp`, a host-side authenticated MCP server that exposes twenty sandbox verbs as in-process calls into `sandbox-core`, so a container agent can drive the sandbox with no Docker socket mounted.

**Architecture:** A fourth workspace under `apps/`, headless, built with plain `tsc`. Four source files: `main.ts` (transport, auth, CORS), `tools.ts` (twenty registrations), `lib/token.ts`, `lib/feature.ts`. Every tool is a thin adapter — validate with zod, call the core function inside `withReporter(collectingReporter(), …)`, return the transcript as `content` and the typed result as `structuredContent`. Lifecycle is `sandbox-core/web_servers`'s existing `WebApp` machinery plus one new entry; `sandbox connect` starts it. Three small gaps in `sandbox-core` are closed first.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: bundler`), `@modelcontextprotocol/sdk` ^1.30.0, `express` ^5, `zod` ^4, `sandbox-core`. Tests are `node --test` over `*.test.mjs` against `dist/`.

**Spec:** `docs/superpowers/specs/2026-09-04-mcp-surface-design.md`
**Prerequisite read:** `docs/superpowers/specs/2026-09-04-command-logic-to-core-design.md`

---

## Global Constraints

- **`apps/mcp` depends on `sandbox-core` only.** Never import from `apps/cli` or `apps/sandbox-dashboard`, and never shell out to the `sandbox` CLI (spec D4).
- **Four source files.** `main.ts`, `tools.ts`, `lib/token.ts`, `lib/feature.ts`. A fifth means verb logic is leaking back out of core — re-read §4 of the predecessor spec before adding one.
- **Port 3002, stem `sandbox-mcp`.** Fixed, not configurable (see the `web_servers.ts` module docstring).
- **Every tool name is prefixed `sandbox-`.**
- **`passthrough` is false on every reporter this server installs.** A child process must never inherit this server's stdio — under `--stdio` that stdout is the JSON-RPC transport.
- **The token is never written into `.mcp.json`.** That file lives in a git worktree and would be committed.
- **Output preservation:** `sandbox logs` and `sandbox test` must print the same bytes after this work as before it. The CLI passes `follow: true` and owns a TTY, so both paths keep inheriting stdio.
- **Hermetic tests.** Anything touching `~/.sandbox` uses `withSandboxHome` from `packages/sandbox-core/fixtures.mjs`, or overrides `process.env.HOME` to a tmpdir (`os.homedir()` honours `$HOME` on POSIX). No test may read the developer's real registry.
- **Absent verbs, permanently or for now:** `setup` and `config` (spec D6); `clean`, `stats`, `optimize` (spec D7). Do not add them.
- **Commit after every task.** Conventional-commit subjects, and end every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## Deviations from the spec, and why

Four places where the code found during planning makes the spec's letter more expensive than its intent. All four keep the intent exactly.

**A. No per-request `AbortController`.** Spec §4 says `main.ts` creates one per request and wires `res.on("close")` to `abort()`. The SDK already does this: `Protocol._onclose()` aborts every in-flight request handler's controller (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:259`), and the handler receives that controller's signal as `extra.signal`. Keeping the dashboard's `res.on("close", () => { transport.close(); server.close(); })` wiring therefore gives a disconnecting client exactly the Ctrl-C semantics D4 existed for, with no controller of our own. The six signal-taking tools pass `extra.signal` straight through.

**B. No `cors` dependency.** Spec §3 lists `cors`; spec §4 then says to reject any request carrying an `Origin` header outright. A four-line middleware does that. The `cors` package exists to build allowlists, and this server has none.

**C. `web_servers.start()` gains a self-bounce guard.** Spec §3 says "no new lifecycle code", and adding `MCP` to `ALL` is indeed all the lifecycle needed — but `infra.up()` calls `startAll(true)` (`infra.ts:362`), and `sandbox-connect` is a tool *on this server*. Without a guard, calling it makes `start(MCP)` see a stale `dist/`, `stop()` the pid in the file, and SIGTERM the process serving the request. The guard is: if the pid file holds `process.pid`, leave it alone. Three lines in one place, correct for every caller.

**D. `${FEATURE}` substitutes only when the feature is non-empty.** An empty `FEATURE` would write `"X-Sandbox-Feature": ""`, a header that silently resolves to no feature. Leaving `${FEATURE}` literal instead makes the misconfiguration visible.

**E. No `outputSchema` on the tool registrations.** Spec §3's "twenty zod schemas in one file" is the *input* schemas; the SDK validates `structuredContent` only when an `outputSchema` is registered (`server/mcp.js:186`), and twenty output schemas would restate core's TypeScript types with no enforcement TypeScript is not already doing.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/mcp/package.json` | `sandbox-mcp`, private, `tsc` build, `node --test` suite. |
| `apps/mcp/tsconfig.json` | Same compiler options as `packages/sandbox-core`, emitting to `dist/`. |
| `apps/mcp/main.ts` | Stdio vs HTTP entry, Origin refusal, bearer auth, the `/mcp` route. |
| `apps/mcp/tools.ts` | The `adapt()` helper and all twenty registrations. |
| `apps/mcp/lib/token.ts` | `~/.sandbox/mcp-token` read-or-create; the authorization predicate. |
| `apps/mcp/lib/feature.ts` | Header/argument → feature, and feature → workspace directory. |
| `apps/mcp/README.md` | What it is, how it is started, how a container reaches it. |
| `apps/mcp/token.test.mjs` | Token creation, mode, and the auth predicate's four cases. |
| `apps/mcp/feature.test.mjs` | Override, header, and the neither-supplied error. |
| `packages/sandbox-core/mcp-gen-vars.test.mjs` | `${…}` substitution and passthrough of unmatched vars. |
| `packages/sandbox-core/compose-logs-args.test.mjs` | The `follow`/`tail` argv. |
| `packages/sandbox-core/web-servers-self.test.mjs` | The self-bounce guard. |

**Modified**

| File | Change |
|---|---|
| `packages/sandbox-core/compose.ts` | `composeLogs` gains `{ follow, tail, signal }`; honours `passthrough()`. |
| `packages/sandbox-core/test_run.ts` | `runFeatureTests` honours `passthrough()`. |
| `packages/sandbox-core/mcp_gen.ts` | `writeWorkspaceMcp` gains `vars`. |
| `packages/sandbox-core/workspace_init.ts` | Passes `{ FEATURE }` to `writeWorkspaceMcp`. |
| `packages/sandbox-core/web_servers.ts` | `MCP` entry, added to `ALL`; self-bounce guard in `start()`. |
| `packages/sandbox-core/lifecycle.ts` | Export `readServicesFromWorkspace`. |
| `apps/cli/src/commands/logs.ts` | Passes the signal in the new options object. |
| `~/.sandbox/services.yaml` | `mcp_servers.sandbox` definition; a second, socket-free container anchor. |
| `docs/users-guide.md` | The k8s-forwards limitation no longer applies to a container calling this server. |

---

## Task 1: `composeLogs` gains `{ follow, tail }` and honours `passthrough()`

Spec §5b item 2 and the first half of item 3. Without `follow: false` the `sandbox-logs` tool never returns; without the capture fix its output goes to this server's stdout, which under `--stdio` is the JSON-RPC transport.

**Files:**
- Modify: `packages/sandbox-core/compose.ts:399-431`
- Modify: `apps/cli/src/commands/logs.ts:30`
- Test: `packages/sandbox-core/compose-logs-args.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ComposeLogsOptions {
    /** Stream until aborted (`-f`). Default true — what the CLI has always done. */
    follow?: boolean;
    /** Lines of history. Default 100. */
    tail?: number;
    signal?: AbortSignal;
  }
  export function composeLogsArgs(service: string | null | undefined, follow: boolean, tail: number): string[];
  export async function composeLogs(feature: string, service?: string | null, opts?: ComposeLogsOptions): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/compose-logs-args.test.mjs`:

```js
// The follow/tail pair is the whole behavioural difference between the CLI's
// unbounded tail and the MCP surface's bounded read, and it is unobservable
// through composeLogs itself without a live docker daemon -- hence the seam.
import { test } from "node:test";
import assert from "node:assert/strict";

import { composeLogsArgs } from "./dist/compose.js";

test("the CLI's tail follows and defaults to 100 lines", () => {
  assert.deepEqual(composeLogsArgs(null, true, 100), ["logs", "-f", "--tail", "100"]);
});

test("a bounded read drops -f so the child exits on its own", () => {
  assert.deepEqual(composeLogsArgs(null, false, 200), ["logs", "--tail", "200"]);
  // Without this the sandbox-logs tool hangs until the client disconnects and
  // the disconnect is the only result.
  assert.ok(!composeLogsArgs(null, false, 200).includes("-f"));
});

test("a service filter goes last, after the flags", () => {
  assert.deepEqual(composeLogsArgs("api", false, 50), ["logs", "--tail", "50", "api"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test compose-logs-args.test.mjs`
Expected: FAIL — `SyntaxError: The requested module './dist/compose.js' does not provide an export named 'composeLogsArgs'`

- [ ] **Step 3: Write the implementation**

In `packages/sandbox-core/compose.ts`, replace the whole `composeLogs` function (currently lines 399-431, ending at the `reportComposeFailure(err)` catch) with:

```ts
/**
 * The `docker compose logs` argv tail.
 *
 * Exported for its own test: the follow/tail pair is the only behavioural
 * difference between a CLI tail and a bounded remote read, and inside
 * `composeLogs` it is unobservable without a live daemon.
 */
export function composeLogsArgs(
  service: string | null | undefined,
  follow: boolean,
  tail: number,
): string[] {
  const args = ["logs"];
  if (follow) {
    args.push("-f");
  }
  args.push("--tail", String(tail));
  if (service) {
    args.push(service);
  }
  return args;
}

export interface ComposeLogsOptions {
  /** Stream until *signal* aborts (`-f`). Default true — the CLI's behaviour. */
  follow?: boolean;
  /** Lines of history to show. Default 100. */
  tail?: number;
  signal?: AbortSignal;
}

/**
 * Tail docker compose logs for *feature*.
 *
 * If *service* is given, only show logs for that container. With `follow`
 * (the default) this streams until *signal* aborts (Ctrl+C, for the CLI); with
 * `follow: false` it returns when the child exits, which is what makes it
 * usable as a request/response tool rather than a subscription.
 *
 * The slot guard lives here rather than in the caller so every consumer gets
 * told *why* a tail produced nothing. Without it a feature that was never
 * brought up reports a bare "no docker-compose.yml", which is true but not the
 * useful half of the answer.
 */
export async function composeLogs(
  feature: string,
  service?: string | null,
  { follow = true, tail = 100, signal }: ComposeLogsOptions = {},
): Promise<void> {
  if ((await getSlot(feature)) === null) {
    warn(`Feature '${feature}' is not running (no slot allocated)`);
    warn(`Start it with: sandbox up ${feature}`);
    return;
  }

  info(`Tailing logs for '${feature}'` + (service ? ` (${service})` : ""));
  if (follow) {
    raw(`${Colors.DIM}Press Ctrl+C to stop${Colors.RESET}\n`);
  }

  const cmd = composeCommand(feature, composeLogsArgs(service, follow, tail), null);
  if (cmd === null) {
    return;
  }
  // A TTY caller watches the tail live through inherited stdio. An in-process
  // one owns no TTY -- its stdout may be an MCP transport -- so capture and
  // replay through the reporter instead (the workspace_init.ts:1003 rule).
  const live = passthrough();
  try {
    // No timeout: a followed tail runs until the reader stops it, and a bounded
    // one is already bounded by the child's own exit.
    const result = await runAsync(cmd, { signal, ...(live ? {} : { capture: true }) });
    if (!live) {
      if (result.stdout) raw(result.stdout);
      if (result.stderr) raw(result.stderr, "stderr");
    }
  } catch (err) {
    reportComposeFailure(err);
  }
}
```

Add `passthrough` to the existing `./reporter.js` import at the top of `compose.ts` (it already imports `info`, `raw`, `warn`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test compose-logs-args.test.mjs compose-logs-guard.test.mjs`
Expected: PASS — including the pre-existing guard test, which calls `composeLogs("no-such-feature-hopefully")` with no options and must still warn.

- [ ] **Step 5: Update the CLI call site**

In `apps/cli/src/commands/logs.ts`, line 30, replace:

```ts
  await composeLogs(feature, service, interruptSignal());
```

with:

```ts
  await composeLogs(feature, service, { signal: interruptSignal() });
```

`follow` and `tail` keep their defaults, so the CLI's rendered output is byte-identical.

- [ ] **Step 6: Verify the whole suite still builds and passes**

Run: `npx turbo run typecheck build test`
Expected: PASS. A `composeLogs(feature, service, signal)` call left anywhere is a type error here.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/compose.ts packages/sandbox-core/compose-logs-args.test.mjs apps/cli/src/commands/logs.ts
git commit -m "$(cat <<'MSG'
feat(core): composeLogs takes follow/tail and honours passthrough

A bounded read is what makes `docker compose logs` usable as a tool call
rather than a subscription that ends only when the client disconnects, and
capturing under a non-TTY reporter keeps a chatty child off a stdout that
may be a JSON-RPC transport.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 2: `runFeatureTests` honours `passthrough()`

Spec §5b item 3, second half. `runAsync` with no `capture` means `stdio: "inherit"`, so one `sandbox-test` call under `--stdio` corrupts the protocol stream; over HTTP the Playwright output is simply lost, because it never reaches the collecting reporter.

**Files:**
- Modify: `packages/sandbox-core/test_run.ts:96-100`

**Interfaces:**
- Consumes: `passthrough` from `./reporter.js` (already exported).
- Produces: no signature change. `runFeatureTests(args): Promise<TestRunResult>` as before.

**Note on testing:** this task ships no new automated test. The only observable behaviour is where a spawned `npx playwright` writes, and the command is hardcoded, so a hermetic check would have to fake the spawn — more machinery than the four-line change. It is covered by verification §10.8 in Task 11, which is the regression test that matters: without this change the failure presents as a corrupted JSON-RPC stream, not as a logging bug.

- [ ] **Step 1: Make the change**

In `packages/sandbox-core/test_run.ts`, add `passthrough` to the existing `./reporter.js` import:

```ts
import { info, passthrough, raw, warn } from "./reporter.js";
```

Then replace the `try` block's first two lines (currently lines 96-98):

```ts
  try {
    const result = await runAsync(cmd, { env, cwd, timeout: TEST_TIMEOUT_SECONDS, signal });
    return { status: result.status, cwd, slot };
```

with:

```ts
  // A terminal caller watches Playwright live through inherited stdio. An
  // in-process one owns no TTY -- its stdout may be an MCP transport -- so
  // capture and replay through the reporter instead, which is also the only
  // way the output reaches a tool result at all.
  const live = passthrough();
  try {
    const result = await runAsync(cmd, {
      env,
      cwd,
      timeout: TEST_TIMEOUT_SECONDS,
      signal,
      ...(live ? {} : { capture: true }),
    });
    if (!live) {
      if (result.stdout) raw(result.stdout);
      if (result.stderr) raw(result.stderr, "stderr");
    }
    return { status: result.status, cwd, slot };
```

The `catch` block below is unchanged: a ProcError already carries its own `stdout`/`stderr`, and the two coded `SandboxError`s it raises are the whole diagnosis.

- [ ] **Step 2: Verify the CLI's output is unchanged**

Run: `npx turbo run typecheck build test`
Then, against any running feature, confirm live Playwright output still streams:
Run: `./sandbox test <feature>`
Expected: the suite's output appears progressively, exactly as before — the CLI installs `ttyReporter`, whose `passthrough` is true.

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox-core/test_run.ts
git commit -m "$(cat <<'MSG'
fix(core): runFeatureTests must not inherit a non-TTY caller's stdio

`runAsync` with no capture is `stdio: "inherit"`, so a suite launched from a
server whose stdout is a JSON-RPC transport corrupts the protocol stream, and
one launched over HTTP loses its output entirely. Same latent bug the
dashboard and claudeck have on this path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 3: `writeWorkspaceMcp` gains `vars`

Spec §5b item 1 and §5. `writeWorkspaceMcp` writes each definition body verbatim, so it cannot vary the feature per workspace — and the whole feature-resolution design turns on each workspace's `.mcp.json` carrying its own `X-Sandbox-Feature`.

**Files:**
- Modify: `packages/sandbox-core/mcp_gen.ts:72-125`
- Modify: `packages/sandbox-core/workspace_init.ts:978`
- Test: `packages/sandbox-core/mcp-gen-vars.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function writeWorkspaceMcp(
    workspaceRoot: string,
    serverNames: string[],
    definitions: Record<string, any>,
    vars?: Record<string, string>,
  ): string | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/mcp-gen-vars.test.mjs`:

```js
// The feature has to travel per workspace, and the definition registry is one
// shared free-form blob -- so substitution happens on the way out, over the
// definition body, rather than as a field the registry schema knows about.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeWorkspaceMcp } from "./dist/mcp_gen.js";

const DEFINITIONS = {
  sandbox: {
    type: "http",
    url: "http://host.docker.internal:3002/mcp",
    headers: {
      Authorization: "Bearer ${SANDBOX_MCP_TOKEN}",
      "X-Sandbox-Feature": "${FEATURE}",
    },
  },
};

function withWorkspace(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gen-vars-"));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function readServers(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8")).mcpServers;
}

test("a named var is substituted into string values at any depth", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS, { FEATURE: "frontend" });
    assert.equal(readServers(ws).sandbox.headers["X-Sandbox-Feature"], "frontend");
  });
});

test("an unnamed var is written through untouched for the MCP client to expand", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS, { FEATURE: "frontend" });
    // The token must never be baked into a file inside a git worktree.
    assert.equal(readServers(ws).sandbox.headers.Authorization, "Bearer ${SANDBOX_MCP_TOKEN}");
  });
});

test("two workspaces get two different features from one definition registry", () => {
  withWorkspace((a) =>
    withWorkspace((b) => {
      writeWorkspaceMcp(a, ["sandbox"], DEFINITIONS, { FEATURE: "alpha" });
      writeWorkspaceMcp(b, ["sandbox"], DEFINITIONS, { FEATURE: "beta" });
      assert.equal(readServers(a).sandbox.headers["X-Sandbox-Feature"], "alpha");
      assert.equal(readServers(b).sandbox.headers["X-Sandbox-Feature"], "beta");
    }),
  );
});

test("substitution never mutates the caller's definition registry", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS, { FEATURE: "frontend" });
    assert.equal(DEFINITIONS.sandbox.headers["X-Sandbox-Feature"], "${FEATURE}");
  });
});

test("no vars leaves every definition exactly as given", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS);
    assert.equal(readServers(ws).sandbox.headers["X-Sandbox-Feature"], "${FEATURE}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test mcp-gen-vars.test.mjs`
Expected: FAIL — the first, third and fourth tests report `'${FEATURE}' !== 'frontend'`.

- [ ] **Step 3: Write the implementation**

In `packages/sandbox-core/mcp_gen.ts`, add above `writeWorkspaceMcp`:

```ts
/**
 * Replace `${NAME}` in every string of *value* for each name in *vars*.
 *
 * A dumb recursive string substitution over the definition body rather than a
 * field the registry schema knows about: the registry stays free-form JSON, and
 * any future server that wants the feature gets it the same way. An unmatched
 * `${...}` — `${SANDBOX_MCP_TOKEN}`, expanded by the MCP client from the
 * container's environment — is written through untouched, which is what keeps
 * the token out of a file that lives inside a git worktree.
 *
 * Returns new values throughout: the caller's `definitions` is the shared
 * registry, reused for every workspace in the same process.
 */
function substituteVars(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (match, name: string) =>
      name in vars ? vars[name] : match,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVars(item, vars));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteVars(v, vars)]),
    );
  }
  return value;
}
```

Change the signature and the one line that fills `wanted`:

```ts
export function writeWorkspaceMcp(
  workspaceRoot: string,
  serverNames: string[],
  definitions: Record<string, any>,
  vars: Record<string, string> = {},
): string | null {
```

```ts
  const wanted: Record<string, any> = {};
  for (const name of serverNames) {
    if (name in definitions) wanted[name] = substituteVars(definitions[name], vars);
  }
```

Everything else in the function — the merge, the prune, the unparseable-JSON bail — is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test mcp-gen-vars.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Pass the feature from `init-workspace`**

In `packages/sandbox-core/workspace_init.ts`, replace line 978:

```ts
  const mcpPath = writeWorkspaceMcp(workspaceRoot, resolveWorkspaceMcpServers(present, archetypes), mcpDefinitions);
```

with:

```ts
  // Only when non-empty: substituting "" would write an X-Sandbox-Feature header
  // that silently resolves to no feature, where a literal `${FEATURE}` left in
  // the file makes the misconfiguration visible.
  const mcpFeature = (meta["FEATURE"] ?? "").trim();
  const mcpPath = writeWorkspaceMcp(
    workspaceRoot,
    resolveWorkspaceMcpServers(present, archetypes),
    mcpDefinitions,
    mcpFeature ? { FEATURE: mcpFeature } : {},
  );
```

- [ ] **Step 6: Verify**

Run: `npx turbo run typecheck build test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/mcp_gen.ts packages/sandbox-core/mcp-gen-vars.test.mjs packages/sandbox-core/workspace_init.ts
git commit -m "$(cat <<'MSG'
feat(core): writeWorkspaceMcp substitutes vars into definition bodies

One shared definition registry has to project a different X-Sandbox-Feature
into every workspace's .mcp.json. A dumb `${NAME}` pass over the definition
body does it without the registry schema learning about features, and leaves
`${SANDBOX_MCP_TOKEN}` untouched for the client to expand — the token must
never land in a file inside a git worktree.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 4: `web_servers` learns about the MCP server, and stops bouncing itself

Spec §3. Adding one `WebApp` entry buys the whole lifecycle — PID file, log file, staleness rebuild, port reaping, `sandbox connect` start, `sandbox down/stop/restart infra`. The self-bounce guard is deviation C: `sandbox-connect` is a tool *on this server*, and `infra.up()` calls `startAll(true)`.

**Files:**
- Modify: `packages/sandbox-core/web_servers.ts` (module docstring, new `MCP` const, `ALL`, `start()`)
- Test: `packages/sandbox-core/web-servers-self.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const MCP: WebApp;             // label "Sandbox MCP server", dir "mcp", port 3002, stem "sandbox-mcp"
  export const ALL: readonly WebApp[];  // now [DASHBOARD, CLAUDECK, MCP]
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/web-servers-self.test.mjs`:

```js
// `sandbox connect` runs as a tool ON the MCP server, and infra.up() calls
// startAll(). Without the guard below, a stale dist/ makes start() SIGTERM the
// pid in the file -- which is the process serving the request.
//
// Hermetic: os.homedir() honours $HOME on POSIX, so the whole PID-file state
// dir moves to a tmpdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { ALL, DASHBOARD, MCP, start } from "./dist/web_servers.js";

test("MCP is one of the servers `sandbox connect` brings up, on its own stem", () => {
  assert.ok(ALL.includes(MCP));
  assert.equal(MCP.port, 3002);
  // DASHBOARD already holds "mcp-server"; a collision would make the two apps
  // share a PID file and reap each other.
  assert.notEqual(MCP.stem, DASHBOARD.stem);
  assert.equal(MCP.stem, "sandbox-mcp");
});

test("start() leaves a server alone when the PID file is this very process", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "web-servers-self-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const pidFile = path.join(home, ".sandbox", `${MCP.stem}.pid`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
  try {
    const reporter = collectingReporter();
    const ok = await withReporter(reporter, () => start(MCP));
    assert.equal(ok, true);
    assert.match(reporter.text(), /this process/);
    // Nothing was stopped, so nothing removed the file.
    assert.equal(fs.readFileSync(pidFile, "utf8"), String(process.pid));
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test web-servers-self.test.mjs`
Expected: FAIL — `does not provide an export named 'MCP'`.

- [ ] **Step 3: Add the `MCP` entry**

In `packages/sandbox-core/web_servers.ts`, after the `CLAUDECK` const:

```ts
/**
 * The remote MCP surface (`apps/mcp`) — the authenticated, headless sibling of
 * DASHBOARD. Its stem is `sandbox-mcp` and not `mcp-server`, which DASHBOARD
 * already holds: a shared stem means a shared PID file and two apps reaping
 * each other. Port 3002 is free — dashboard 3001, claudeck 9009, feature slots
 * from 11100 (`getPortRange`).
 */
export const MCP: WebApp = {
  label: "Sandbox MCP server",
  dir: "mcp",
  port: 3002,
  stem: "sandbox-mcp",
  entry: "dist/main.js",
  buildRef: "dist/main.js",
};

/** Every app `sandbox connect` brings up (and `down`/`stop`/`restart` manage). */
export const ALL: readonly WebApp[] = [DASHBOARD, CLAUDECK, MCP];
```

(Replace the existing `ALL` declaration; do not leave two.)

Update the module docstring's first paragraph to name three apps rather than two:

```ts
/**
 * Lifecycle for the sandbox's host web servers — the workspaces dashboard /
 * MCP app (apps/sandbox-dashboard), Claudeck (apps/claudeck), and the remote
 * MCP surface (apps/mcp).
```

- [ ] **Step 4: Add the self-bounce guard**

In `start()`, immediately after `const [running, pid] = isRunning(app);` and **before** the `appDir`/`package.json` check:

```ts
  // Never bounce ourselves. `sandbox connect` is a tool on apps/mcp, and it
  // reaches infra.up() -> startAll(): a stale dist/ would otherwise make this
  // call SIGTERM the pid in the file, which is the process serving the request.
  if (running && pid === process.pid) {
    success(`${app.label} is this process (pid ${pid}); leaving it running`);
    return true;
  }
```

`stop()` deliberately gets no guard: `stopAll` is reached only from `infra.down`/`infra.stop`, neither of which is on the tool surface (spec §6). Add one there the day a teardown verb is exposed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test web-servers-self.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Verify nothing else broke**

Run: `npx turbo run typecheck build test`
Expected: PASS. `startAll` will now try to start `apps/mcp`, which does not exist yet — `start()` warns "Sandbox MCP server not found at …; skipping" and returns false, which is non-fatal by design. Do **not** run `./sandbox connect` yet.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/web_servers.ts packages/sandbox-core/web-servers-self.test.mjs
git commit -m "$(cat <<'MSG'
feat(core): register apps/mcp as a managed host web server

One WebApp entry buys the whole lifecycle -- PID file, log, staleness
rebuild, port reaping, `sandbox connect`. The guard is the new part:
`sandbox-connect` is a tool on that server and reaches startAll(), which
without it would SIGTERM the process serving the request.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 5: `apps/mcp` skeleton, token, and feature resolution

The workspace plus the two pure libraries. Both libraries are the parts of the
server that hold real branching logic, and both are testable without a daemon,
a socket, or a network — so they come first and arrive with their tests.

**Files:**
- Create: `apps/mcp/package.json`, `apps/mcp/tsconfig.json`
- Create: `apps/mcp/lib/token.ts`, `apps/mcp/lib/feature.ts`
- Test: `apps/mcp/token.test.mjs`, `apps/mcp/feature.test.mjs`
- Modify: `packages/sandbox-core/lifecycle.ts:272` (export `readServicesFromWorkspace`)

**Interfaces:**
- Consumes: `SandboxError` (`sandbox-core/errors`), `workspaceForFeature` (`sandbox-core/compose`).
- Produces:
  ```ts
  // lib/token.ts
  export function tokenPath(): string;
  export function readOrCreateToken(): string;
  export function isLoopback(host: string): boolean;
  export function authorized(header: string | undefined, token: string, host: string): boolean;

  // lib/feature.ts
  export const FEATURE_HEADER = "x-sandbox-feature";
  export type ReqHeaders = Record<string, string | string[] | undefined> | undefined;
  export function resolveFeature(explicit: string | undefined, headers: ReqHeaders): string;
  export function resolveWorkspaceDir(feature: string): string;
  ```

- [ ] **Step 1: Create the workspace**

Create `apps/mcp/package.json`:

```json
{
  "name": "sandbox-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Headless, authenticated MCP server exposing the sandbox verbs to a container agent with no Docker access.",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "serve:stdio": "node dist/main.js --stdio",
    "serve:http": "node dist/main.js",
    "test": "tsc && node --test *.test.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "express": "^5.1.0",
    "sandbox-core": "^0.1.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "typescript": "^5.9.3"
  }
}
```

No vite, no `@modelcontextprotocol/ext-apps`, no React, no `cors` — see spec §3 and deviation B.

Create `apps/mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": false,
    "outDir": "dist",
    "rootDir": ".",
    "noEmit": false,
    "types": ["node"]
  },
  // A glob, not a list: `tsc` errors TS6053 on a named file that does not
  // exist, and main.ts/tools.ts arrive a task later than this file does.
  // Same reasoning as packages/sandbox-core/tsconfig.json.
  "include": ["*.ts", "lib/*.ts"]
}
```

Then install so the workspace is linked:

Run: `npm install`

- [ ] **Step 2: Write the failing token test**

Create `apps/mcp/token.test.mjs`:

```js
// The predicate is the whole authentication rule, in one place: a token is
// required whenever the bind is not loopback, and a present token is always
// checked. Hermetic -- os.homedir() honours $HOME, so ~/.sandbox moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { authorized, isLoopback, readOrCreateToken, tokenPath } from "./dist/lib/token.js";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-token-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the token is created 0600 on first read and reused after", () => {
  withHome(() => {
    const first = readOrCreateToken();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(tokenPath()).mode & 0o777, 0o600);
    assert.equal(readOrCreateToken(), first);
  });
});

test("a loopback bind accepts a missing header, so host clients need no config", () => {
  assert.equal(authorized(undefined, "abc", "127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
});

test("a non-loopback bind refuses a missing header", () => {
  assert.equal(authorized(undefined, "abc", "0.0.0.0"), false);
});

test("a present token is checked on every bind, right or wrong", () => {
  assert.equal(authorized("Bearer abc", "abc", "127.0.0.1"), true);
  assert.equal(authorized("Bearer abc", "abc", "0.0.0.0"), true);
  assert.equal(authorized("Bearer wrong", "abc", "127.0.0.1"), false);
  assert.equal(authorized("Bearer wrong", "abc", "0.0.0.0"), false);
});

test("a malformed or wrong-length credential is refused, not compared", () => {
  assert.equal(authorized("abc", "abc", "0.0.0.0"), false);
  assert.equal(authorized("Bearer ", "abc", "0.0.0.0"), false);
  // timingSafeEqual throws on unequal lengths; the length check must come first.
  assert.equal(authorized("Bearer abcdefgh", "abc", "0.0.0.0"), false);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/mcp && npx tsc && node --test token.test.mjs`
Expected: FAIL — `Cannot find module './dist/lib/token.js'`.

- [ ] **Step 4: Write `lib/token.ts`**

Create `apps/mcp/lib/token.ts`:

```ts
/**
 * The shared secret that stands between a container and the host's Docker
 * daemon, and the single predicate that decides whether a request carries it.
 *
 * 32 random bytes as hex in `~/.sandbox/mcp-token`, mode 0600, created on first
 * start. The container gets it through its environment (`SANDBOX_MCP_TOKEN`),
 * never through the `.mcp.json` that lives in a git worktree.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function tokenPath(): string {
  return path.join(os.homedir(), ".sandbox", "mcp-token");
}

/** Read the token, creating it on first start. */
export function readOrCreateToken(): string {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // absent — fall through and create it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * May this request proceed?
 *
 * One predicate rather than a per-route flag: a token is REQUIRED whenever the
 * bind is not loopback, and a token that is present is always checked — so a
 * host stdio/loopback client needs no configuration, and a container-reachable
 * bind cannot be left open by forgetting a flag somewhere.
 *
 * The length check precedes `timingSafeEqual`, which throws on unequal-length
 * buffers.
 */
export function authorized(header: string | undefined, token: string, host: string): boolean {
  if (header === undefined) {
    return isLoopback(host);
  }
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match) {
    return false;
  }
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

- [ ] **Step 5: Run the token test to verify it passes**

Run: `cd apps/mcp && npx tsc && node --test token.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing feature test**

Create `apps/mcp/feature.test.mjs`:

```js
// The server cannot see the client's cwd, so the feature travels in a header
// pinned by the workspace's own .mcp.json. An explicit argument still wins --
// one agent, one container, occasionally two features.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxError } from "sandbox-core/errors";
import { FEATURE_HEADER, resolveFeature } from "./dist/lib/feature.js";

test("the header supplies the feature when no argument does", () => {
  assert.equal(resolveFeature(undefined, { [FEATURE_HEADER]: "frontend" }), "frontend");
});

test("an explicit argument overrides the header", () => {
  assert.equal(resolveFeature("backend", { [FEATURE_HEADER]: "frontend" }), "backend");
});

test("neither is a coded error naming both ways to supply it", () => {
  assert.throws(
    () => resolveFeature(undefined, undefined),
    (e) => {
      assert.ok(e instanceof SandboxError);
      assert.equal(e.code, "NO_FEATURE");
      assert.match(e.message, /feature/);
      assert.match(e.message, /X-Sandbox-Feature/);
      return true;
    },
  );
});

test("blank values on either side count as absent", () => {
  assert.throws(() => resolveFeature("   ", { [FEATURE_HEADER]: "  " }), { code: "NO_FEATURE" });
});

test("a repeated header takes the first value", () => {
  assert.equal(resolveFeature(undefined, { [FEATURE_HEADER]: ["alpha", "beta"] }), "alpha");
});
```

- [ ] **Step 7: Write `lib/feature.ts`**

Create `apps/mcp/lib/feature.ts`:

```ts
/**
 * Which feature is this call about, and where does its workspace live?
 *
 * One container mounts all of `~/features` and the agent is opened in a feature
 * directory — but the server cannot see the client's cwd, so the feature
 * travels in `X-Sandbox-Feature`, pinned by the workspace's own generated
 * `.mcp.json`. Every tool that takes a feature declares it as an *optional*
 * argument defaulting to the header, so an agent working across two features
 * can still name one.
 *
 * The workspace directory is never a second header: it is resolved from the
 * feature by the same `workspaceForFeature` every other consumer uses.
 */

import { workspaceForFeature } from "sandbox-core/compose";
import { SandboxError } from "sandbox-core/errors";

/** Lower-cased: Node lower-cases incoming header names. */
export const FEATURE_HEADER = "x-sandbox-feature";

export type ReqHeaders = Record<string, string | string[] | undefined> | undefined;

export function resolveFeature(explicit: string | undefined, headers: ReqHeaders): string {
  const raw = headers?.[FEATURE_HEADER];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  const feature = (explicit ?? fromHeader ?? "").trim();
  if (!feature) {
    throw new SandboxError(
      "No feature for this call. Pass a `feature` argument, or set the " +
        "X-Sandbox-Feature header on the MCP connection (the workspace's " +
        ".mcp.json does this for you).",
      "NO_FEATURE",
    );
  }
  return feature;
}

/** The feature's workspace directory, or a coded error the caller can render. */
export function resolveWorkspaceDir(feature: string): string {
  const workspace = workspaceForFeature(feature);
  if (workspace === null) {
    throw new SandboxError(
      `Could not resolve a workspace for feature '${feature}' — no running ` +
        "containers carry its label and no workspace directory holds its " +
        "docker-compose.yml.",
      "WORKSPACE",
    );
  }
  return workspace;
}
```

- [ ] **Step 8: Run the feature test to verify it passes**

Run: `cd apps/mcp && npx tsc && node --test feature.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 9: Export `readServicesFromWorkspace` from core**

`sandbox-intercept` (Task 9) needs the workspace's `SERVICES` list, which the CLI reads with its own `loadDotenv`. Core already has the same read at `packages/sandbox-core/lifecycle.ts:272`; a second consumer makes it public. Change one word:

```ts
/** Read the SERVICES list from <workspace>/.env (written by init-workspace). */
export function readServicesFromWorkspace(workspace: string): string[] {
```

Leave `apps/cli/src/commands/intercept.ts` alone — the CLI is out of scope (spec §11).

- [ ] **Step 10: Verify and commit**

Run: `npx turbo run typecheck build test`
Expected: PASS.

```bash
git add apps/mcp packages/sandbox-core/lifecycle.ts package-lock.json
git commit -m "$(cat <<'MSG'
feat(mcp): apps/mcp workspace with token and feature resolution

The two pieces of the server that hold real branching -- the single
authorization predicate and the header/argument feature resolution -- with
their tests. No transport yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 6: `main.ts` — transport, binding, authentication

Spec §4. Mirrors the dashboard's two-mode entry point and adds the
authentication it lacks. Deviations A (no per-request controller) and B (no
`cors`) apply.

**Files:**
- Create: `apps/mcp/main.ts`
- Create: `apps/mcp/tools.ts` (an empty `registerTools` for now — filled in Tasks 7-9)

**Interfaces:**
- Consumes: `authorized`, `readOrCreateToken` (Task 5).
- Produces: `export function registerTools(server: McpServer): void` in `tools.ts`, called by `main.ts`.

- [ ] **Step 1: Create the empty tool registry**

Create `apps/mcp/tools.ts`:

```ts
/**
 * The twenty tool registrations.
 *
 * Every one is a thin adapter: validate with zod, call the core function inside
 * a collecting reporter, return the transcript as `content` and the typed
 * result as `structuredContent`. Nothing here decides anything a verb should
 * decide — if a registration grows a branch about *what the verb does*, that
 * logic belongs in `sandbox-core` (predecessor spec §4).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTools(_server: McpServer): void {
  // Filled in by the three tool tasks.
}
```

- [ ] **Step 2: Write `main.ts`**

Create `apps/mcp/main.ts`:

```ts
/**
 * Entry point for the remote sandbox MCP surface.
 *
 *   node dist/main.js --stdio    # a host-local client (Claude Desktop, host CLI)
 *   node dist/main.js            # Streamable HTTP on PORT (default 3002)
 *
 * This server holds the privilege a container is denied: it runs on the host,
 * with the host's Docker daemon, and exposes only the verbs. Everything that
 * keeps that honest lives below — the bind, the Origin refusal, and the bearer
 * token.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";

import { authorized, readOrCreateToken } from "./lib/token.js";
import { registerTools } from "./tools.js";

function createServer(): McpServer {
  const server = new McpServer({ name: "sandbox", version: "0.1.0" });
  registerTools(server);
  return server;
}

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel on stdio — diagnostics must go to stderr.
  console.error("[sandbox-mcp] MCP server running on stdio");
}

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3002", 10);
  // Loopback by default. HOST=0.0.0.0 is the container case: the container
  // network is the isolation boundary and Docker's published port is the only
  // way in — and on that bind the token below stops being optional.
  const host = process.env.HOST ?? "127.0.0.1";
  const token = readOrCreateToken();
  const app = createMcpExpressApp({ host });

  // No browser UI here, so any Origin at all is a browser reaching a server
  // that has none. Refusing outright is both less code than an allowlist and
  // strictly safer; same-origin and non-browser clients send no Origin.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.origin !== undefined) {
      res.status(403).end();
      return;
    }
    next();
  });

  // One predicate, one place. Ahead of the route so nothing is reachable
  // without it, and after the Origin check so a browser gets no 401 oracle.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!authorized(req.headers.authorization, token, host)) {
      res.status(401).end();
      return;
    }
    next();
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Closing the server on disconnect is also the abort: Protocol._onclose()
    // aborts every in-flight request handler's controller, which is the
    // `extra.signal` the six long-running tools pass into core. A client that
    // hangs up stops the work — the remote equivalent of Ctrl-C.
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, host, (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.error(`[sandbox-mcp] listening on http://${host}:${port}/mcp`);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  if (process.argv.includes("--stdio")) {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Build, then check the bind, the token, and the three refusals**

Every check below runs in ONE shell invocation: a background server started in
one shell is not reachable from the next, and `kill %1` in a later shell has no
job to kill.

Cleanup tracks the PID it started. Do **not** reach for `pkill -f`: the server's
cmdline is `node dist/main.js` (cwd-relative), so a pattern narrow enough to be
safe never matches, and one broad enough to match also matches
`apps/sandbox-dashboard`, whose entry is the identical `dist/main.js`. Killing
by pattern here either does nothing — silently leaving a stale server that makes
the next probe pass for the wrong reason — or kills the dashboard.

Run:

```bash
cd apps/mcp && npm run build && bash -c '
srv=""
start() { node dist/main.js & srv=$!; sleep 1; }
stop() { [ -n "$srv" ] && kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null; srv=""; }
trap stop EXIT

probe() { curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3002/mcp   -H "Content-Type: application/json" "$@" -d "{}"; echo; }

echo "--- loopback bind ---"
start
ls -l ~/.sandbox/mcp-token
echo -n "no header (expect NOT 401):   "; probe
echo -n "any Origin (expect 403):      "; probe -H "Origin: https://evil.example"
echo -n "wrong token (expect 401):     "; probe -H "Authorization: Bearer wrong"
stop

echo "--- 0.0.0.0 bind ---"
HOST=0.0.0.0 node dist/main.js & srv=$!; sleep 1
echo -n "no header (expect 401):       "; probe
echo -n "right token (expect NOT 401): "; probe -H "Authorization: Bearer $(cat ~/.sandbox/mcp-token)"
'
```

Expected, in order: the token file is `-rw-------`; then on loopback a
non-401 (the SDK answers `406 Not Acceptable` to a POST without its required
`Accept` header — that is the pass, because the request *reached the route*),
`403`, `401`; then on `0.0.0.0` a `401` and a non-401.

**A 406 where you expected a 401 on the `0.0.0.0` bind means the loopback
server never died** and your probes are hitting it. Check for a survivor before
believing any of these numbers.

- [ ] **Step 4: Confirm nothing survived**

Run: `lsof -ti tcp:3002 -sTCP:LISTEN || echo "port 3002 free"`
Expected: `port 3002 free`. A stray listener on 3002 makes every later task's
probe answer for the wrong server; kill it by the PID `lsof` reports before
moving on.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/main.ts apps/mcp/tools.ts
git commit -m "$(cat <<'MSG'
feat(mcp): transport, bind, Origin refusal and bearer auth

Two-mode entry point mirroring the dashboard's, plus the authentication it
does not have. No per-request AbortController: the SDK aborts in-flight
handlers when the transport closes, so `extra.signal` already is the
client-disconnected signal.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 7: Tools — the adapter, plus lifecycle and inspection (11 tools)

Spec §6 and §7. The `adapt()` helper is what makes the other nineteen
registrations one line of glue each, so it lands here with the first family.

**Files:**
- Modify: `apps/mcp/tools.ts`

**Interfaces:**
- Consumes: `resolveFeature`, `resolveWorkspaceDir` (Task 5); `composeLogs` with `{ follow, tail, signal }` (Task 1).
- Produces (used by Tasks 8 and 9):
  ```ts
  type Extra = {
    signal: AbortSignal;
    requestInfo?: { headers: Record<string, string | string[] | undefined> };
  };
  function adapt(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult>;
  const FEATURE_ARG: { feature: z.ZodOptional<z.ZodString> };
  ```

- [ ] **Step 1: Write the adapter and the shared argument**

Replace the body of `apps/mcp/tools.ts` (keeping the module docstring) with:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { composeLogs } from "sandbox-core/compose";
import { sandboxRoot } from "sandbox-core/config";
import { detectReport } from "sandbox-core/detect";
import { SandboxError } from "sandbox-core/errors";
import { down, removeService, reloadProxy, restart, stop, up } from "sandbox-core/lifecycle";
import { collectingReporter, withReporter } from "sandbox-core/reporter";
import { featureServices } from "sandbox-core/slots";
import { interceptsSnapshot, statusSnapshot } from "sandbox-core/status";
import { runFeatureTests } from "sandbox-core/test_run";

import { resolveFeature, resolveWorkspaceDir } from "./lib/feature.js";

/**
 * What the SDK hands a tool handler. `signal` is aborted when the request is
 * cancelled OR the transport closes, so it is the client-disconnected signal;
 * `requestInfo` carries the original HTTP headers, which is where the feature
 * comes from.
 */
type Extra = {
  signal: AbortSignal;
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
};

/**
 * Run one core call and shape it into a tool result.
 *
 * `content` is the transcript the CLI would have printed for that verb,
 * character for character — that is what makes this surface legible to an agent
 * without twenty renderers here. `structuredContent` is the typed result,
 * verbatim. The reporter is AsyncLocalStorage-scoped, so concurrent tool calls
 * do not interleave and no correlation id is needed.
 *
 * `passthrough` is false on this reporter (collectingReporter's default) and
 * must stay false: on `--stdio` this process's stdout is the JSON-RPC channel.
 */
async function adapt(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  const reporter = collectingReporter();
  try {
    const structuredContent = await withReporter(reporter, fn);
    return { content: [{ type: "text", text: reporter.text() }], structuredContent };
  } catch (e) {
    if (e instanceof SandboxError) {
      // The codes (NOT_RUNNING, WORKSPACE, …) are the remote analogue of the
      // CLI's exit codes: something for the caller to branch on.
      return {
        isError: true,
        content: [{ type: "text", text: e.message }],
        structuredContent: { code: e.code },
      };
    }
    // Anything else is unexpected, and the transcript is usually the only
    // diagnosis there is.
    return {
      isError: true,
      content: [{ type: "text", text: `${(e as Error).message}\n\n${reporter.text()}` }],
    };
  }
}

/**
 * The feature argument every feature-scoped tool shares: optional, defaulting
 * to the connection's `X-Sandbox-Feature` header.
 */
const FEATURE_ARG = {
  feature: z
    .string()
    .optional()
    .describe("Feature name. Defaults to the X-Sandbox-Feature header on the connection."),
};

export function registerTools(server: McpServer): void {
  registerLifecycleTools(server);
}
```

`registerAuthoringTools` and `registerHostTools` join that body in Tasks 8 and 9.

- [ ] **Step 2: Register the eleven lifecycle and inspection tools**

Append to `apps/mcp/tools.ts`:

```ts
// ---------------------------------------------------------------------------
// Lifecycle and inspection
// ---------------------------------------------------------------------------

function registerLifecycleTools(server: McpServer): void {
  server.registerTool(
    "sandbox-up",
    {
      title: "Bring a feature up",
      description:
        "Allocate the feature's slot, start its containers, and point the reverse proxy at " +
        "them. Returns the slot, port range, local services and their URLs.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return { ...(await up(feature, resolveWorkspaceDir(feature), { signal: extra.signal })) };
      }),
  );

  server.registerTool(
    "sandbox-down",
    {
      title: "Tear a feature down",
      description:
        "Leave the feature's k8s intercepts, remove its containers, and release its slot. " +
        "Does not reload the reverse proxy — call sandbox-proxy-reload after tearing down.",
      inputSchema: {
        ...FEATURE_ARG,
        removeVolumes: z
          .boolean()
          .optional()
          .describe("Also remove the feature's named volumes. Default false."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return {
          ...(await down(feature, {
            removeVolumes: args.removeVolumes ?? false,
            signal: extra.signal,
          })),
        };
      }),
  );

  server.registerTool(
    "sandbox-stop",
    {
      title: "Stop a feature's containers",
      description:
        "Stop the containers, leaving them and the slot in place so sandbox-restart or " +
        "sandbox-up can resume the feature.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await stop(resolveFeature(args.feature, (extra as Extra).requestInfo?.headers))),
      })),
  );

  server.registerTool(
    "sandbox-restart",
    {
      title: "Restart a feature's containers",
      description: "Bounce the feature's containers, reusing its slot.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await restart(resolveFeature(args.feature, (extra as Extra).requestInfo?.headers))),
      })),
  );

  server.registerTool(
    "sandbox-status",
    {
      title: "Sandbox status",
      description:
        "Everything `sandbox status` knows: infrastructure containers, the host web servers, " +
        "k8s forwards, every feature's slot and containers, and telepresence intercepts. " +
        "Host-side, so the k8s forward health reported here is the real one.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await statusSnapshot()),
        telepresence: await interceptsSnapshot(),
      })),
  );

  server.registerTool(
    "sandbox-detect",
    {
      title: "Detect changed services",
      description:
        "Which registered services this feature's workspace has local changes for, and which " +
        "have none.",
      inputSchema: {
        ...FEATURE_ARG,
        workspace: z.string().optional().describe("Override the resolved workspace directory."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...detectReport(
          resolveFeature(args.feature, (extra as Extra).requestInfo?.headers),
          args.workspace ?? null,
        ),
      })),
  );

  server.registerTool(
    "sandbox-services",
    {
      title: "Where a feature's services answer",
      description:
        "Every registered service and its endpoint for this feature — local container, k8s " +
        "forward, or not configured.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await featureServices(
          resolveFeature(args.feature, (extra as Extra).requestInfo?.headers),
        )),
      })),
  );

  server.registerTool(
    "sandbox-logs",
    {
      title: "Read a feature's container logs",
      description:
        "A bounded read of `docker compose logs` for the feature, optionally one service. This " +
        "is not a subscription: it never follows, and returns the last `tail` lines.",
      inputSchema: {
        ...FEATURE_ARG,
        service: z.string().optional().describe("Limit to one service's container."),
        tail: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Lines of history to return. Default 200."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const service = args.service ?? null;
        const tail = args.tail ?? 200;
        // follow: false is what makes this return at all; the signal still
        // covers a client that hangs up mid-read.
        await composeLogs(feature, service, { follow: false, tail, signal: extra.signal });
        return { feature, service, tail };
      }),
  );

  server.registerTool(
    "sandbox-remove",
    {
      title: "Drop a service from a feature",
      description:
        "Remove one service from the feature's local services so it falls back to k8s: " +
        "regenerate the workspace files, restart (or stop) the containers, re-point the proxy.",
      inputSchema: {
        ...FEATURE_ARG,
        service: z.string().describe("The local service to drop."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await removeService(
          resolveFeature(args.feature, (extra as Extra).requestInfo?.headers),
          args.service,
        )),
      })),
  );

  server.registerTool(
    "sandbox-test",
    {
      title: "Run a feature's Playwright suite",
      description:
        "Run the feature's Playwright tests with SANDBOX_FEATURE set, so the suite carries the " +
        "X-Feature routing cookie. A failing suite is a result (non-zero `status`), not an error.",
      inputSchema: {
        ...FEATURE_ARG,
        extraArgs: z
          .array(z.string())
          .optional()
          .describe("Extra arguments appended to `npx playwright test`."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return {
          ...(await runFeatureTests({
            feature,
            workspace: resolveWorkspaceDir(feature),
            root: sandboxRoot(),
            extraArgs: args.extraArgs ?? [],
            signal: extra.signal,
          })),
        };
      }),
  );

  server.registerTool(
    "sandbox-proxy-reload",
    {
      title: "Regenerate and reload the reverse proxy",
      description:
        "Rebuild the Caddyfile from the active features and hand it to Caddy, starting Caddy if " +
        "it is down. Call this after tearing features down.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      adapt(async () => ({ ...(await reloadProxy({ start: true })) })),
  );
}
```

- [ ] **Step 3: Build and typecheck**

Run: `cd apps/mcp && npm run build`
Expected: clean.

- [ ] **Step 4: List the tools over stdio**

Run:
```bash
cd apps/mcp && printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/main.js --stdio | tail -1 | tr ',' '\n' | grep '"name"'
```
Expected: the eleven `sandbox-*` names above, and nothing on stdout that is not JSON-RPC.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp/tools.ts
git commit -m "$(cat <<'MSG'
feat(mcp): adapter plus the eleven lifecycle and inspection tools

Each registration is zod in, core call, transcript and typed result out. The
transcript is what the CLI would have printed, so the surface is legible to
an agent without twenty renderers living here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 8: Tools — workspace authoring (6 tools)

Spec §6. These bind to the non-interactive halves of the workspace verbs: the
TTY wizard and the `readline` resolvers stay in the CLI (predecessor spec §7),
and every input they would prompt for is a tool argument here.

**Files:**
- Modify: `apps/mcp/tools.ts`

**Interfaces:**
- Consumes: `adapt`, `FEATURE_ARG`, `Extra` (Task 7).
- Produces: `registerAuthoringTools(server: McpServer): void`.

- [ ] **Step 1: Add the imports**

At the top of `apps/mcp/tools.ts`, extend the import block:

```ts
import { writeWorkspaceHooks } from "sandbox-core/hooks_gen";
import { buildContext, listNotes, parseNote } from "sandbox-core/notes";
import { graduateNote } from "sandbox-core/graduate";
import { createWorkspace } from "sandbox-core";
import { checkStandards } from "sandbox-core/standards";
import { checkSkills, syncSkills } from "sandbox-core/workspace_skills";
import { initWorkspace } from "sandbox-core/workspace_init";
```

- [ ] **Step 2: Register the six tools**

Append to `apps/mcp/tools.ts`:

```ts
// ---------------------------------------------------------------------------
// Workspace authoring
// ---------------------------------------------------------------------------

/**
 * The wizard's fields as tool arguments.
 *
 * `sandbox-workspace` binds to `createWorkspace`, the non-interactive path the
 * dashboard already drives — not to the TTY wizard in `commands/workspace.ts`.
 * Every input the wizard would prompt for is here, so nothing has to block on a
 * terminal that does not exist.
 */
const WORKSPACE_FIELDS = {
  repos: z.string().optional().describe("Comma-separated repos to check out."),
  services: z.string().optional().describe("Comma-separated services to run locally."),
  jira_id: z.string().optional().describe("Jira ticket key or URL."),
  work_type: z.string().optional().describe("Work type (drives the workspace phases)."),
  task: z.string().optional().describe("One-line task title."),
  description: z.string().optional().describe("Longer description."),
  labels: z.string().optional().describe("Comma-separated labels."),
  test_path: z.string().optional().describe("Default path for `sandbox open` and the suite."),
  starting_prompt: z.string().optional().describe("Prompt the workspace's first session starts from."),
};

function registerAuthoringTools(server: McpServer): void {
  server.registerTool(
    "sandbox-workspace",
    {
      title: "Create a sandbox workspace",
      description:
        "Create a workspace: git worktrees on a <user>/<workspace> branch under the workspaces " +
        "root, then init-workspace. Non-interactive — every wizard input is an argument here. " +
        "Never opens VS Code.",
      inputSchema: {
        feature: z.string().describe("Feature name. Required — this creates the feature."),
        ...WORKSPACE_FIELDS,
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => ({
        // open: false — a container agent has no desktop, and launching an
        // editor is sandbox-open's job, asked for explicitly.
        ...(await createWorkspace({ ...args }, { open: false })),
      })),
  );

  server.registerTool(
    "sandbox-init-workspace",
    {
      title: "Reconcile a workspace",
      description:
        "Re-run init-workspace against an existing workspace: reconcile worktrees, regenerate " +
        "CLAUDE.md, .env, docker-compose.yml, skills, agents, hooks and .mcp.json from " +
        ".sandbox/workspace.yml plus any arguments given here.",
      inputSchema: { ...FEATURE_ARG, ...WORKSPACE_FIELDS },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        // No readStdinTask: fd 0 here may be the MCP transport.
        await initWorkspace({ ...args, feature }, workspace);
        return { feature, workspace };
      }),
  );

  server.registerTool(
    "sandbox-skills",
    {
      title: "Check or sync a workspace's projected skills",
      description:
        "`check` reports authoring problems in this repo's standards and drift in the " +
        "workspace's .claude/skills/. `sync` reprojects the skills and refreshes the gate " +
        "manifest.",
      inputSchema: {
        ...FEATURE_ARG,
        action: z.enum(["check", "sync"]).describe("check reports drift; sync fixes it."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        return args.action === "sync"
          ? { ...syncSkills(workspace) }
          : { ...checkSkills(workspace) };
      }),
  );

  server.registerTool(
    "sandbox-standards",
    {
      title: "Validate the standards tree",
      description:
        "Run every structural validator over the configured standards tree. Errors come back as " +
        "data — an empty `errors` with a non-zero `moduleCount` is a clean tree.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => adapt(async () => ({ ...checkStandards() })),
  );

  server.registerTool(
    "sandbox-hooks",
    {
      title: "Write a workspace's Claude Code hooks",
      description:
        "Merge the SessionStart and PreToolUse gate entries into the workspace's " +
        ".claude/settings.json. Never clobbers hooks it does not own.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return { path: writeWorkspaceHooks(resolveWorkspaceDir(feature)) };
      }),
  );

  server.registerTool(
    "sandbox-notes",
    {
      title: "Read or graduate a workspace's notes",
      description:
        "`context` renders the session-start standards + notes block. `list` returns the " +
        "workspace's notes. `graduate` scaffolds a decision note into a standards domain — " +
        "domain and kind must be supplied, because the CLI's prompts are not available here.",
      inputSchema: {
        ...FEATURE_ARG,
        action: z.enum(["context", "list", "graduate"]),
        includeSuperseded: z.boolean().optional().describe("list: include superseded notes."),
        notePath: z.string().optional().describe("graduate: absolute path of the decision note."),
        domain: z.string().optional().describe("graduate: standards domain to scaffold into."),
        kind: z
          .enum(["rule", "example", "anti-pattern"])
          .optional()
          .describe("graduate: what kind of standard this becomes."),
        slug: z.string().optional().describe("graduate: filename slug. Defaults from the note."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        if (args.action === "context") {
          return { context: buildContext(workspace, "mcp") };
        }
        if (args.action === "list") {
          return { notes: listNotes(workspace, args.includeSuperseded ?? false) };
        }
        if (!args.notePath || !args.domain || !args.kind) {
          throw new SandboxError(
            "graduate needs `notePath`, `domain` and `kind` — the CLI resolves these by " +
              "prompting, which a remote caller cannot do.",
            "ARGS",
          );
        }
        const note = parseNote(args.notePath);
        if (note === null) {
          throw new SandboxError(`Not a readable note: ${args.notePath}`, "ARGS");
        }
        return {
          scaffolded: graduateNote(workspace, note, {
            domain: args.domain,
            kind: args.kind,
            slug: args.slug ?? null,
          }),
        };
      }),
  );
}
```

- [ ] **Step 3: Call it from `registerTools`**

```ts
export function registerTools(server: McpServer): void {
  registerLifecycleTools(server);
  registerAuthoringTools(server);
}
```

- [ ] **Step 4: Build and list**

Run: `cd apps/mcp && npm run build`
Expected: clean.

Re-run the `tools/list` command from Task 7 Step 4.
Expected: seventeen `sandbox-*` names.

- [ ] **Step 5: Smoke one read-only tool end to end**

Run:
```bash
cd apps/mcp && printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sandbox-standards","arguments":{}}}' \
  | node dist/main.js --stdio | tail -1
```
Expected: a result carrying `structuredContent` with `dir`, `moduleCount` and `errors`, and `content` holding the transcript.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/tools.ts
git commit -m "$(cat <<'MSG'
feat(mcp): the six workspace-authoring tools

Bound to the non-interactive halves -- createWorkspace rather than the TTY
wizard, graduateNote with domain and kind as arguments rather than the
readline resolvers. Every input the wizard would prompt for is an argument.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 9: Tools — host-side (3 tools)

Spec §6. These three reach beyond the caller's own feature and have host-desktop
side effects. They are in because a container agent that cannot start shared
infra or open a browser against its own feature is not doing the job — and they
are the widest blast radius on the surface, the first thing to gate if the
token's authority is ever narrowed. Say so in their descriptions.

**Files:**
- Modify: `apps/mcp/tools.ts`

**Interfaces:**
- Consumes: `adapt`, `FEATURE_ARG`, `Extra` (Task 7); `readServicesFromWorkspace` (Task 5 Step 9).
- Produces: `registerHostTools(server: McpServer): void`.

- [ ] **Step 1: Add the imports**

```ts
import { launchFeatureWindow, readWorkspaceYaml } from "sandbox-core/browser";
import { featureUrl } from "sandbox-core/feature_routing";
import { connectK8s, up as infraUp } from "sandbox-core/infra";
import { readServicesFromWorkspace } from "sandbox-core/lifecycle";
import { leaveIntercept, startIntercept } from "sandbox-core/telepresence";
```

`readServicesFromWorkspace` joins the existing `sandbox-core/lifecycle` import from Task 7.

- [ ] **Step 2: Register the three tools**

Append to `apps/mcp/tools.ts`:

```ts
// ---------------------------------------------------------------------------
// Host-side
//
// These three reach beyond the caller's own feature and have host-desktop side
// effects. They are the widest blast radius on this surface: the first thing to
// gate if the token's authority is ever narrowed.
// ---------------------------------------------------------------------------

function registerHostTools(server: McpServer): void {
  server.registerTool(
    "sandbox-connect",
    {
      title: "Start shared infrastructure",
      description:
        "Bring up the shared infra every feature depends on: generated proxy files, the " +
        "corporate CA, the compose stack (caddy, k8s forwards, jaeger) and the host web " +
        "servers. Host-wide, not scoped to your feature.",
      inputSchema: {
        k8sOnly: z
          .boolean()
          .optional()
          .describe("Start/restart only the k8s port-forwards container. Default false."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        if (args.k8sOnly) {
          return { k8s: connectK8s() };
        }
        // Health is deliberately not awaited here: infraHealth() waits up to 90
        // seconds for the forwards to converge, which is a `sandbox-status`
        // call away and should not be inside this one.
        return { infraOk: await infraUp({ signal: extra.signal }) };
      }),
  );

  server.registerTool(
    "sandbox-open",
    {
      title: "Open a feature-tagged browser window",
      description:
        "Launch a browser window on the HOST, pre-configured with the feature's X-Feature " +
        "routing cookie and tagged so it is unmistakably this feature's window. The window " +
        "outlives this call; it closes when the user closes it.",
      inputSchema: {
        ...FEATURE_ARG,
        url: z.string().optional().describe("Explicit URL. Wins over `path`."),
        path: z
          .string()
          .optional()
          .describe("Path on the feature's routed host. Defaults to workspace.yml test_path, else /."),
        size: z.string().optional().describe("Window size as W,H."),
        position: z.string().optional().describe("Window position as X,Y."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        const url =
          args.url ??
          featureUrl(args.path ?? readWorkspaceYaml(workspace)["test_path"] ?? "/");
        if (url === null) {
          throw new SandboxError(
            "No routed hosts in services.yaml (no service declares `feature_router:`) — " +
              "pass an explicit `url`.",
            "NO_ROUTE",
          );
        }
        const window = await launchFeatureWindow(feature, url, {
          size: args.size,
          position: args.position ?? null,
        });
        if (window === null) {
          throw new SandboxError(
            "Could not launch a browser window — see the transcript for why.",
            "BROWSER",
          );
        }
        // supervise() owns the cleanup and resolves only when the window
        // closes, so it is started and NOT awaited: this tool returns once the
        // window is up and tagged.
        void window.supervise();
        return { feature, url };
      }),
  );

  server.registerTool(
    "sandbox-intercept",
    {
      title: "Start or leave a k8s traffic intercept",
      description:
        "Route the slice of live k8s dev traffic carrying `x-feature: <feature>` to this " +
        "feature's local container, or stop doing so. Runs host-side, where the telepresence " +
        "root daemon lives — with exactly the authority a host terminal has.",
      inputSchema: {
        ...FEATURE_ARG,
        action: z.enum(["start", "leave"]),
        service: z
          .string()
          .optional()
          .describe("Required to start. On leave, omit to leave every intercept of the feature."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const localServices = readServicesFromWorkspace(resolveWorkspaceDir(feature));
        if (args.action === "leave") {
          return {
            left: await leaveIntercept({
              feature,
              service: args.service ?? null,
              localServices,
              signal: extra.signal,
            }),
          };
        }
        if (!args.service) {
          throw new SandboxError("`service` is required to start an intercept.", "ARGS");
        }
        return {
          ...(await startIntercept({
            feature,
            service: args.service,
            localServices,
            signal: extra.signal,
          })),
        };
      }),
  );
}
```

- [ ] **Step 3: Call it from `registerTools`**

```ts
export function registerTools(server: McpServer): void {
  registerLifecycleTools(server);
  registerAuthoringTools(server);
  registerHostTools(server);
}
```

- [ ] **Step 4: Build, list, and confirm the absences**

Run: `cd apps/mcp && npm run build`
Expected: clean.

Re-run the `tools/list` command from Task 7 Step 4.
Expected: exactly twenty `sandbox-*` names, and **none** of `sandbox-setup`,
`sandbox-config`, `sandbox-clean`, `sandbox-stats`, `sandbox-optimize`
(spec D6, D7).

- [ ] **Step 5: Verify the whole monorepo**

Run: `npx turbo run typecheck build test` and `./sandbox standards check`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp/tools.ts
git commit -m "$(cat <<'MSG'
feat(mcp): the three host-side tools, completing the twenty

connect, open and intercept reach past the caller's own feature and touch the
host desktop. They are in because an agent that cannot start shared infra or
open a browser on its feature is not doing the job -- and they are the first
thing to gate if this token's authority is ever narrowed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 10: Host configuration, container wiring, and docs

Spec §5 and §8. The registry that projects `.mcp.json` and the compose block a
container uses both live in `~/.sandbox/services.yaml`, **outside this repo** —
they are machine-global config, not versioned code. This task changes that file
by hand and records what it did in the repo's docs, so the next machine can be
set up from the plan.

**Files:**
- Modify: `~/.sandbox/services.yaml` (host config, not in git)
- Create: `apps/mcp/README.md`
- Modify: `docs/users-guide.md`

**Interfaces:**
- Consumes: `writeWorkspaceMcp`'s `vars` (Task 3), `MCP` in `ALL` (Task 4).
- Produces: the `sandbox` MCP server definition every workspace's `.mcp.json` gets.

- [ ] **Step 1: Back up the host registry**

Run: `cp ~/.sandbox/services.yaml ~/.sandbox/services.yaml.bak-mcp-surface`

- [ ] **Step 2: Add the `sandbox` server definition**

In `~/.sandbox/services.yaml`, under the existing `mcp_servers:` block (next to
`context7`), add:

```yaml
  # The host-side sandbox surface (apps/mcp). ${FEATURE} is substituted per
  # workspace by `sandbox init-workspace`; ${SANDBOX_MCP_TOKEN} is deliberately
  # NOT -- the MCP client expands it from the container's environment, because
  # .mcp.json lives inside a git worktree and would be committed.
  sandbox:
    type: http
    url: http://host.docker.internal:3002/mcp
    headers:
      Authorization: "Bearer ${SANDBOX_MCP_TOKEN}"
      X-Sandbox-Feature: "${FEATURE}"
```

- [ ] **Step 3: Enable it for the archetypes that should get it**

In the same file's `archetypes:` block, add `sandbox` to the `mcp_servers:` list
of every archetype whose workspaces should carry the surface. For the current
registry that is `node-web` (which already lists `context7`) and `node-tool`:

```yaml
  node-web:
    standards: [engineering, testing, frontend]
    mcp_servers: [context7, sandbox]
    test: "npm test"
  node-tool:
    standards: [engineering, testing]
    mcp_servers: [sandbox]
```

(Take the surrounding keys from the file as it stands; only the `mcp_servers:`
lines change.)

- [ ] **Step 4: Add a socket-free container block**

The whole point of this work is the socket coming out — but not out of
*everything*. The existing `&host_mounts` / `&host_env` anchors serve the
self-host dogfood services (`cli`, `sandbox-dashboard`, `claudeck`), which exist
to run the CLI and the dashboard **directly** in a container and genuinely need
the daemon. Spec §8 is about a container that uses *this surface* instead. So
this adds a second anchor rather than gutting the first.

In `~/.sandbox/services.yaml`, next to the existing anchors on the `cli:` entry,
add:

```yaml
    # A container that drives the sandbox through the host MCP surface
    # (apps/mcp) instead of the daemon. The difference from &host_mounts is the
    # whole point of that surface: no /var/run/docker.sock, which is root on the
    # host for anything that gets code execution in here.
    extra_volumes: &mcp_client_mounts
      # Kept at identical host paths: the agent edits code here, and generated
      # compose files on the host carry host paths.
      - /Users/jayboyer/repos:/Users/jayboyer/repos
      - /Users/jayboyer/features:/Users/jayboyer/features
    environment: &mcp_client_env
      HOME: /Users/jayboyer
      GIT_CONFIG_COUNT: "1"
      GIT_CONFIG_KEY_0: safe.directory
      GIT_CONFIG_VALUE_0: "*"
      # Expanded into .mcp.json's Authorization header by the MCP client. The
      # token itself never enters .mcp.json -- that file is inside a worktree.
      SANDBOX_MCP_TOKEN: ${SANDBOX_MCP_TOKEN}
```

Then alias it (`extra_volumes: *mcp_client_mounts`, `environment: *mcp_client_env`)
from the service entry of the container that is meant to use the surface.

What is deliberately absent, and why (spec §8):

| Absent | Why |
|---|---|
| `/var/run/docker.sock` | The mount this work exists to remove. |
| `~/.sandbox`, `~/.kube` | The host server reads them; the container never does. |
| `tools:/opt/sandbox-tools`, `/opt/sandbox-tools/bin` on PATH, `DOCKER_CONFIG` | Nothing in here runs docker, compose or kubectl any more. |
| `/app/apps/cli` on PATH | The verbs arrive as MCP tools, not as a `sandbox` binary. |
| `HOST` | Only the servers being *self-hosted* need it; this container hosts nothing. |

YAML anchors must be defined before they are aliased, so keep these on the
`cli:` entry alongside the existing pair, which must stay above every entry that
aliases either.

`SANDBOX_MCP_TOKEN` reaches compose from the host shell. If this machine's
secret plumbing is what supplies it, add
`SANDBOX_MCP_TOKEN=<contents of ~/.sandbox/mcp-token>` to `~/.sandbox/secrets.env`
and declare `secrets: [SANDBOX_MCP_TOKEN]` on that service entry — a
declared-but-missing secret makes `sandbox up` refuse the whole workspace, which
is the failure you want rather than a container that silently gets 401s.

- [ ] **Step 5: Start the server for real and reproject a workspace**

Run: `./sandbox connect`
Expected: among the other servers, `Sandbox MCP server started (pid …, http://localhost:3002/)`.

Run: `cd <a feature workspace> && sandbox init-workspace`
Run: `cat <that workspace>/.mcp.json`
Expected: an `mcpServers.sandbox` entry whose `X-Sandbox-Feature` is that
workspace's feature and whose `Authorization` is the literal
`Bearer ${SANDBOX_MCP_TOKEN}` — no hex anywhere in the file.

- [ ] **Step 6: Write the README**

Create `apps/mcp/README.md`:

```markdown
# sandbox-mcp

The remote MCP surface for the sandbox verbs. Headless, authenticated, and
host-side: it holds the Docker privilege so a container agent does not have to.

## Why it exists

Self-hosting the sandbox gave a container the host's Docker socket, and the
daemon is root on the host. This server is the same capability with that mount
removed — twenty verbs over HTTP instead of a socket.

## Running it

`sandbox connect` starts it, like the dashboard and claudeck: it is a `WebApp`
in `packages/sandbox-core/web_servers.ts` (stem `sandbox-mcp`, port 3002, PID
and log under `~/.sandbox`). By hand:

    npm run build && npm run serve:http    # Streamable HTTP on :3002
    npm run serve:stdio                    # stdio, for a host-local client

## Authentication

32 random bytes of hex in `~/.sandbox/mcp-token`, mode 0600, created on first
start. A bearer token is REQUIRED whenever `HOST` is not a loopback address, and
is checked whenever it is present — so a host loopback client needs no
configuration and a container-reachable bind cannot be left open. Any request
carrying an `Origin` header is refused: this server has no browser UI.

## How a container reaches it

`sandbox init-workspace` projects a `sandbox` entry into the workspace's
`.mcp.json` pointing at `http://host.docker.internal:3002/mcp`, with the
workspace's own feature in `X-Sandbox-Feature` and `${SANDBOX_MCP_TOKEN}` left
for the MCP client to expand from the container's environment. The token is
never written into that file — it lives inside a git worktree.

Tools take an optional `feature` argument that overrides the header.

## What is not here

`setup` and `config`, permanently: they mutate the host machine's install and a
remote client cannot repair a broken `~/.zshenv` by calling an API. `clean`,
`stats` and `optimize`, for now: `clean` deletes volumes across every feature,
which is the wrong blast radius for a container-held token, and the other two
are simply not needed yet.

Design: `docs/superpowers/specs/2026-09-04-mcp-surface-design.md`.
```

- [ ] **Step 7: Correct the users guide**

Two bullets in the self-hosting known-limitations list of `docs/users-guide.md`
now have an exception. Both are in the block ending at the `**Not covered:**`
bullet (around lines 832-838).

Replace the loopback bullet:

```markdown
- **Inside the container, `sandbox status` shows every k8s forward as dead** and `kubectl`
  cannot reach OrbStack's API server: both probe `127.0.0.1`, which is the container's own
  loopback. The forwards are fine; read their state from the host. `sandbox up`, `down`,
  `status` (for features) and `workspace` all work from inside.
```

with:

```markdown
- **Inside the container, `sandbox status` shows every k8s forward as dead** and `kubectl`
  cannot reach OrbStack's API server: both probe `127.0.0.1`, which is the container's own
  loopback. The forwards are fine; read their state from the host. `sandbox up`, `down`,
  `status` (for features) and `workspace` all work from inside. This applies to a container
  running the CLI *directly*. A container that calls the host MCP surface (`apps/mcp`)
  instead is unaffected: `sandbox-status` runs on the host, so the forward health it reports
  is the real one.
```

Replace the "Not covered" bullet:

```markdown
- **Not covered:** Telepresence intercepts (need a root daemon on the host), and the `gh` and
  `claude` binaries. Run `sandbox intercept` and `sandbox connect` from the host.
```

with:

```markdown
- **Not covered:** the `gh` and `claude` binaries. Telepresence intercepts need a root daemon
  on the host, so `sandbox intercept` and `sandbox connect` must run there — either from a
  host terminal, or through the `sandbox-intercept` and `sandbox-connect` tools on
  `apps/mcp`, which run host-side with exactly the authority a host terminal has.
```

And add one bullet after the host-access bullet, so the second anchor is
documented where the first one is:

```markdown
- **A container can instead hold no daemon at all.** The `mcp_client` anchors mount only
  `~/repos` and `~/features` and set `SANDBOX_MCP_TOKEN`; the sandbox verbs arrive as MCP
  tools from `apps/mcp` on the host (`http://host.docker.internal:3002/mcp`), pinned to the
  workspace's feature by the `.mcp.json` that `sandbox init-workspace` projects. No docker
  socket, no docker CLI, no kubectl, no `sandbox` binary inside.
```

Leave the `/etc/hosts` bullet as it stands — reconciling hostnames is
`sandbox setup`, which needs sudo and is deliberately not on this surface (D6).

- [ ] **Step 8: Commit**

```bash
git add apps/mcp/README.md docs/users-guide.md
git commit -m "$(cat <<'MSG'
docs(mcp): README and the users-guide limitation this surface fixes

The registry and compose changes live in ~/.sandbox/services.yaml, which is
machine-global config rather than versioned code -- the plan's Task 10 is the
record of what to change there.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 11: End-to-end verification

Spec §10, run in order. Each item is a check with an expected observation; a
failure here is a bug in an earlier task, not a step to work around.

**Files:** none — this task changes no code unless something fails.

- [ ] **Step 1: The gates (§10.1)**

Run: `npx turbo run typecheck build test`
Expected: clean.

Run: `./sandbox standards check`
Expected: clean.

Output preservation on the two changed paths, against a running feature:
Run: `./sandbox logs <feature>` — expected: the same banner, the same
`Press Ctrl+C to stop`, live streaming output, Ctrl-C exits.
Run: `./sandbox test <feature>` — expected: live Playwright output, same banner,
same exit code on a failing suite.

- [ ] **Step 2: Lifecycle and token (§10.2)**

Run: `./sandbox connect`
Expected: `Sandbox MCP server started (pid …, http://localhost:3002/)`.

Run: `ls -l ~/.sandbox/mcp-token && ls -l ~/.sandbox/sandbox-mcp.pid`
Expected: the token is `-rw-------`; the PID file exists and names a live process.

- [ ] **Step 3: Authentication and CORS (§10.3)**

Re-run the probe sequence from Task 6 Step 3 (loopback: no header reaches the
route, any Origin 403, wrong token 401; then `HOST=0.0.0.0`: no header 401,
right token reaches the route). Against the server `sandbox connect` started,
not one of your own — check `lsof -ti tcp:3002 -sTCP:LISTEN` first and probe
that PID's server.
Expected: as stated in Task 6 Step 3.

- [ ] **Step 4: The whole point — a container with no socket (§10.4)**

From inside a sandbox container brought up with Task 10's `*mcp_client_mounts` /
`*mcp_client_env` anchors (not the dogfood `cli` container, which keeps the
socket on purpose):

Run: `docker ps`
Expected: FAILS — no socket, no docker CLI. If this succeeds, the block still
carries the mount and the rest of this step proves nothing.

Then, through the MCP client configured by that workspace's `.mcp.json`, call
`sandbox-up`, `sandbox-status`, `sandbox-logs` and `sandbox-down` against the
container's own feature.
Expected: all four succeed, and `sandbox-status`'s feature list reflects the
`up` and then the `down`.

- [ ] **Step 5: Feature pinning (§10.5)**

Run `sandbox init-workspace` in two different workspaces, then:
Run: `grep -h 'X-Sandbox-Feature\|Authorization' <ws1>/.mcp.json <ws2>/.mcp.json`
Expected: two different feature values; both Authorization lines are the literal
`Bearer ${SANDBOX_MCP_TOKEN}`. No 64-character hex string appears in either file.

- [ ] **Step 6: Feature resolution (§10.6)**

Call any feature-scoped tool over HTTP with no `X-Sandbox-Feature` header and no
`feature` argument.
Expected: a tool error whose text names both ways to supply it, with
`structuredContent.code === "NO_FEATURE"`.

Call it again with an explicit `feature` that differs from the header.
Expected: the argument wins.

- [ ] **Step 7: Abort (§10.7)**

Start a `sandbox-up` on a feature that has to build, then kill the client
mid-call.
Run (on the host): `docker ps | grep 'compose up'` or `ps -ax | grep 'docker compose'`
Expected: no orphaned compose child survives the disconnect.

- [ ] **Step 8: The stdio regression test (§10.8) — the important one**

Run:
```bash
cd apps/mcp && printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sandbox-logs","arguments":{"feature":"<feature>","tail":20}}}' \
  | node dist/main.js --stdio > /tmp/mcp-stdout.jsonl 2>/dev/null
while read -r line; do echo "$line" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' || echo "NOT JSON: $line"; done < /tmp/mcp-stdout.jsonl
```
Expected: every line of stdout parses as JSON, and the container log text appears
inside the tool result's `content`, **not** as loose bytes between messages.

Repeat with `sandbox-test` in place of `sandbox-logs`.
Expected: the same. Without Task 2 this fails as a corrupted JSON-RPC stream —
which does not look like a logging bug, hence this explicit check.

- [ ] **Step 9: Agreement smoke (§10.9)**

Run: `./sandbox status`
Then call `sandbox-status` over the surface.
Expected: the same features, slots, container counts, infra health and intercepts.
Two renderings of one set of facts.

- [ ] **Step 10: Record the result**

If everything passes, note it in the spec's status line:

```bash
sed -i '' 's/^\*\*Status:\*\* approved in chat; not started$/**Status:** implemented — see docs\/superpowers\/plans\/2026-09-04-mcp-surface.md/' docs/superpowers/specs/2026-09-04-mcp-surface-design.md
git add docs/superpowers/specs/2026-09-04-mcp-surface-design.md
git commit -m "$(cat <<'MSG'
docs: mark the mcp-surface design implemented

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Out of scope

Carried from spec §11, restated so no task drifts into them:

- Any change to `apps/cli` beyond `logs.ts` moving its signal into the options
  object (Task 1 Step 5).
- Any change to `apps/sandbox-dashboard`, including consolidating its
  overlapping tools. The two servers overlap by design (spec D1).
- A command manifest (spec D5).
- `setup` and `config` (D6); `clean`, `stats`, `optimize` (D7).
- Per-feature token scoping. The container holds all of `~/features`, so a
  feature-scoped token would be fiction.
- Reimplementing `docker compose`.
