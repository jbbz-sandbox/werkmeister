# Command Logic to Core — Plan 3: The Seven That Need Judgment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the seven verbs whose logic is entangled with a TTY, a cwd
walk-up, a process-wide signal handler, or a synchronous spawn — and unblock
claudeck's `POST /intercept`.

**Architecture:** Each of these has a real reason it was left behind. The split
line is the spec's boundary test: TTY prompting and `process.cwd()` resolution
stay in `apps/cli`; everything else moves. Two tasks are ordered (`notes` before
`down`); the rest are independent.

**Tech Stack:** TypeScript, `node:test` + `assert/strict` for core, vitest for the
CLI, turbo for the workspace.

**Spec:** `docs/superpowers/specs/2026-09-04-command-logic-to-core-design.md` (§5, tier 2)

**Depends on:** Plan 1 (`runAsync`, `interruptSignal`). Plan 2 is independent of
this one and can run in parallel.

## Global Constraints

Same as Plan 2, plus:

- **The TTY boundary is absolute.** `readline`, `@inquirer/prompts`,
  `process.stdin.isTTY` and `process.on("SIGINT", …)` never appear in
  `packages/sandbox-core`. A library may not install process-wide signal handlers
  on whoever imported it — `apps/cli/src/commands/open.ts` states this in a comment
  and it is the rule, not a local exception.
- **`process.cwd()` never appears in a core signature.** The caller resolves and
  passes an explicit feature or workspace path.
- **`spawnSync` blocks the host's event loop.** Anything a long-lived server might
  call must go through `runAsync` (Plan 1 Task 2). This is the whole reason
  `intercept` is a build rather than a lift.
- Verification for every task: `npx turbo run typecheck build test` and
  `./sandbox standards check`.

**Ordering:** Task 1 (`notes`) must land before Task 2 (`down`) —
`apps/cli/src/commands/down.ts:22` imports `graduateOne` and `input` from
`apps/cli/src/commands/notes.ts`. Tasks 3-7 are independent of each other.

---

### Task 1: `notes` — split the context builder from the prompts

`apps/cli/src/commands/notes.ts` is 417 lines mixing three things: a pure context
renderer the SessionStart hook consumes, an interactive graduation flow, and argv.
Only the first moves.

**Files:**
- Modify: `packages/sandbox-core/notes.ts`
- Modify: `apps/cli/src/commands/notes.ts` (417 → ~200)
- Test: `packages/sandbox-core/notes-context.test.mjs` (create)
- Test: `apps/cli/src/commands/__tests__/notes_context.test.ts` (exists; must still pass)

**Interfaces:**
- Consumes: `latestHandoff`, `openDecisions`, `parseNote` (already in `notes.ts`);
  `reconcileGraduating`, `graduateNote` (`./graduate.js`); `standardsMatchingDiff`,
  `loadStandardsModules` (`./standards.js`); `skillNameFor` (`./skill_gen.js`).
- Produces:
```typescript
export const CONTEXT_CHAR_CAP = 9000;
export function renderNote(header: string, note: Note, workspace: string): string;
export function renderDecisions(decisions: Note[], workspace: string, budget: number): string[];
export function renderActiveStandards(pairs: Array<[string, string]>, source: string): string;
export function buildContext(workspace: string, source?: string): string;
```
`graduateOne` does **not** move: it awaits `resolveDomain`/`resolveKind`, which
prompt. `graduateNote` — the part that actually writes — is already in
`packages/sandbox-core/graduate.ts` and stays where it is.

- [ ] **Step 1: Capture current output**

```bash
cd "$(git rev-parse --show-toplevel)"
./sandbox notes context > /tmp/notes.before 2>&1; wc -c /tmp/notes.before
```
Check the real subcommand name in `main.ts`'s `SPECS` entry for `notes` (line 413)
before running this.

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/notes-context.test.mjs`:

```javascript
// The SessionStart hook truncates at ~10k characters, and decisions render last
// — so an unbudgeted list silently drops the newest decisions, which are exactly
// the ones a fresh session needs. The cap is the contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTEXT_CHAR_CAP, renderDecisions } from "./dist/notes.js";

const fakeNote = (n) => ({
  number: n,
  path: `/ws/.sandbox/notes/${String(n).padStart(3, "0")}-decision-x.md`,
  title: `decision ${n}`,
  body: "x".repeat(2000),
  type: "decision",
});

test("renderDecisions stays inside its budget", () => {
  const notes = Array.from({ length: 40 }, (_, i) => fakeNote(i + 1));
  const out = renderDecisions(notes, "/ws", CONTEXT_CHAR_CAP).join("\n");
  assert.ok(out.length <= CONTEXT_CHAR_CAP, `rendered ${out.length} > ${CONTEXT_CHAR_CAP}`);
});

test("renderDecisions keeps the newest and names what it elided", () => {
  const notes = Array.from({ length: 40 }, (_, i) => fakeNote(i + 1));
  const out = renderDecisions(notes, "/ws", CONTEXT_CHAR_CAP).join("\n");
  assert.match(out, /040/, "the newest decision must survive the budget");
  assert.match(out, /00[12]/, "elided decisions must still be listed by path");
});
```

Read `renderDecisions` at `apps/cli/src/commands/notes.ts:102-140` first and shape
the `fakeNote` fixture to whatever `Note` fields it actually reads — the `Note`
interface is at `packages/sandbox-core/notes.ts:26`.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test notes-context.test.mjs`
Expected: FAIL — neither export exists.

- [ ] **Step 4: Move the four renderers**

Move `renderNote`, `renderDecisions`, `renderActiveStandards`, `buildContext` and
the `_CONTEXT_CHAR_CAP` constant from `apps/cli/src/commands/notes.ts` into
`packages/sandbox-core/notes.ts`, renaming the constant to the exported
`CONTEXT_CHAR_CAP`. They are pure string builders; nothing about them changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test notes-context.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Re-point the command and the hook**

`apps/cli/src/commands/notes.ts` imports all four from `sandbox-core/notes`. It
keeps `input`, `stdinIsatty`, `resolveDomain`, `resolveKind`, `graduateOne`,
`runGraduate`, `hookPayload`, `run` and the two small parsers.

- [ ] **Step 7: Verify the hook output is byte-identical**

```bash
./sandbox notes context > /tmp/notes.after 2>&1
diff /tmp/notes.before /tmp/notes.after && echo IDENTICAL
```
This is the highest-stakes diff in all three plans: the SessionStart hook feeds
this to every future session, and a silent truncation change is invisible until
someone re-litigates a settled decision.

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/notes.ts packages/sandbox-core/notes-context.test.mjs apps/cli/src/commands/notes.ts
git commit -m "refactor(core): move the notes context renderers into notes

buildContext and its three renderers are pure and hook-consumed. The
graduation prompts stay in the CLI: resolveDomain and resolveKind read
a TTY, which is the boundary."
```

---

### Task 2: `down` — separate reading notes from prompting about them

**Depends on Task 1.**

`apps/cli/src/commands/down.ts`'s `printNotes` both reads the workspace notes and
prompts for graduation. The read moves; the prompt stays.

**Files:**
- Modify: `packages/sandbox-core/lifecycle.ts`
- Modify: `apps/cli/src/commands/down.ts` (175 → ~120)
- Test: `apps/cli/src/commands/__tests__/down.test.ts` (exists; extend)

**Interfaces:**
- Consumes: `latestHandoff`, `openDecisions` (`./notes.js`), `reconcileGraduating`
  (`./graduate.js`), `workspaceForFeature` (`./compose.js`).
- Produces:
```typescript
export interface TeardownNotes {
  workspace: string | null;
  handoff: Note | null;
  decisions: Note[];
  graduated: string[];   // what reconcileGraduating resolved
}
export async function teardownNotes(feature: string): Promise<TeardownNotes>;
```

- [ ] **Step 1: Extend the existing test**

Add to `apps/cli/src/commands/__tests__/down.test.ts`, which already asserts that
notes are read *before* containers are removed:

```typescript
it("reads the workspace notes through core before tearing down", async () => {
  await go({ feature: "demo" });
  expect(lines.indexOf("<teardownNotes>")).toBeLessThan(lines.indexOf("<down demo>"));
});
```

Add `teardownNotes: vi.fn()` to the existing
`vi.mock("sandbox-core/lifecycle", …)` factory at line 17, and a
`mockImplementation` in `beforeEach` that pushes `"<teardownNotes>"` and returns
`{ workspace: "/ws", handoff: null, decisions: [], graduated: [] }`.

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/cli && npx vitest run src/commands/__tests__/down.test.ts`
Expected: FAIL — `teardownNotes` is not exported from `sandbox-core/lifecycle`.

- [ ] **Step 3: Implement `teardownNotes`**

Move the reads from `apps/cli/src/commands/down.ts:41-117` (`printNotes`) into
`lifecycle.ts`: `workspaceForFeature`, `reconcileGraduating`, `latestHandoff`,
`openDecisions`. Leave every `console.log` behind — those are the printers.

The ordering guarantee the existing test protects must survive: the notes are read
while the containers still exist, because the workspace is resolved *through* them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/cli && npx vitest run src/commands/__tests__/down.test.ts`
Expected: PASS, including the pre-existing assertions about `reloadProxy` being
called once per command.

- [ ] **Step 5: Reduce the command**

`printNotes` becomes a pure renderer over `TeardownNotes`. The graduation prompt
— which calls `graduateOne` and `input` from `./notes.js` — stays exactly where it
is, guarded by the existing `!process.stdin.isTTY` check at `down.ts:66`.

- [ ] **Step 6: Verify the real teardown**

```bash
./sandbox up demo && ./sandbox down demo
```
Expected: the notes block prints as before, and a non-TTY invocation
(`./sandbox down demo < /dev/null`) still falls back to print-only without
blocking.

- [ ] **Step 7: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/lifecycle.ts apps/cli/src/commands/down.ts apps/cli/src/commands/__tests__/down.test.ts
git commit -m "refactor(core): teardownNotes reads what down prints"
```

---

### Task 3: `intercept` — the one real build

The only verb with a consumer already waiting: `apps/claudeck/plugins/sandbox-workspace/server.js`
`POST /intercept` spawns the CLI because no core entry point exists. Three
problems, all of which must be solved together.

**Files:**
- Modify: `packages/sandbox-core/telepresence.ts`
- Modify: `apps/cli/src/commands/intercept.ts` (180 → ~70)
- Test: `packages/sandbox-core/telepresence-intercept.test.mjs` (create)

**Interfaces:**
- Consumes: `versionError`, `interceptBlocker`, `buildInterceptArgs`,
  `buildLeaveArgs`, `ensureConnected`, `leaveFeatureIntercepts`, `Runner`
  (all already in `telepresence.ts`); `getSlot`, `getServicePort` (`./slots.js`);
  `loadServices`, `getK8sContext` (`./config.js`); `loadFeatureRouters`
  (`./feature_routing.js`); `runAsync` (`./proc.js`, Plan 1 Task 2).
- Produces:
```typescript
export function portOpen(port: number, timeoutMs?: number): Promise<boolean>;
export async function runAsyncRunner(cmd: string[], signal?: AbortSignal): Promise<[number, string]>;
export interface InterceptArgs {
  feature: string;
  service: string;
  workspace: string;          // resolved by the caller — never from cwd
  localServices: string[];    // from the caller's .env read — never from cwd
  dockerDaemon?: boolean;
  signal?: AbortSignal;
}
export interface InterceptResult {
  service: string; context: string; namespace: string; deployment: string;
  localPort: number; header: string; remoteHost: string | null;
}
export async function startIntercept(a: InterceptArgs): Promise<InterceptResult>;
export async function leaveIntercept(
  a: { feature: string; service?: string | null; workspace: string; localServices: string[] },
): Promise<string[]>;
```
Every failure throws `SandboxError` with a code: `NOT_LOCAL`, `NOT_INTERCEPTABLE`,
`TELEPRESENCE_VERSION`, `NOT_RUNNING`, `PORT_CLOSED`, `INTERCEPT_FAILED`.
These replace `fail()` at `apps/cli/src/commands/intercept.ts:45`, which calls
`process.exit(1)` — in-process that takes claudeck's express server down.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/telepresence-intercept.test.mjs`:

```javascript
// The command's fail() called process.exit(1). In-process that kills the host
// server, which is exactly why claudeck still spawns the CLI for this route.
// Every rejection is now a coded SandboxError.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxError } from "./dist/errors.js";
import { startIntercept, portOpen } from "./dist/telepresence.js";

const base = {
  feature: "demo",
  workspace: "/tmp",
  localServices: ["backend"],
};

test("a service the workspace does not run locally raises NOT_LOCAL", async () => {
  const err = await startIntercept({ ...base, service: "frontend", localServices: ["backend"] })
    .then(() => null, (e) => e);
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_LOCAL");
});

test("startIntercept never calls process.exit", async () => {
  // If it did, this test file would die here rather than report a failure.
  await startIntercept({ ...base, service: "nope", localServices: [] }).catch(() => {});
  assert.ok(true);
});

test("portOpen resolves false for a closed port rather than hanging", async () => {
  assert.equal(await portOpen(1, 200), false);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test telepresence-intercept.test.mjs`
Expected: FAIL — `startIntercept` is not exported.

- [ ] **Step 3: Move `portOpen` and make the runner async**

Move `portOpen` from `apps/cli/src/commands/intercept.ts:26-43` into
`telepresence.ts`, adding the `timeoutMs` parameter (default 1000, matching
today's `socket.setTimeout(1000)`).

Then add `runAsyncRunner`, a `runAsync`-backed sibling of `_run`. **Do not delete
`_run`** — `listIntercepts`, `connectedNamespace` and `leaveFeatureIntercepts`
take a `Runner` and are called from `status.ts` under a 15s cap; changing them is
a separate concern. `startIntercept` and `leaveIntercept` use the async runner.

- [ ] **Step 4: Implement `startIntercept` and `leaveIntercept`**

Move the body of `apps/cli/src/commands/intercept.ts:76-170`, with two changes:
`resolveServiceDef`'s `loadDotenv` read becomes the caller-supplied
`localServices` array, and each `fail(msg)` becomes
`throw new SandboxError(msg, "<CODE>")` with the codes listed above. Keep every
message string verbatim — they are CLI output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test telepresence-intercept.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/intercept.ts` keeps: the `--status` branch, the
`loadDotenv(process.cwd())` feature resolution, the `resolveWorkspace` call, the
`loadDotenv(workspace)` read that produces `localServices`, a `SandboxError`
catch that prints and exits 1, and the whole "Intercept active" render block at
lines 155-170. It passes `interruptSignal()` as `signal`.

- [ ] **Step 7: Smoke the real path**

```bash
./sandbox up demo -s backend
./sandbox intercept demo -s backend
./sandbox status --intercepts
./sandbox intercept demo --leave -s backend
```
Expected: identical output to before, and `status --intercepts` agrees with what
`intercept` reported. If telepresence is not installed on this machine, confirm
the `TELEPRESENCE_VERSION` path prints the same message and exits 1 as before.

- [ ] **Step 8: Update the known-issues entry**

In `docs/known-issues.md`, under "Claudeck's Streaming Routes Still Spawn the CLI",
change the `/intercept` row's "Core equivalent" from `none yet` to
`startIntercept(...)` / `leaveIntercept(...)`, and rewrite the
"**What blocks `/intercept`**" paragraph to say the core entry point now exists and
the route can be moved — noting that doing so is a claudeck change, out of this
migration's scope.

- [ ] **Step 9: Verify and commit**

```bash
npx turbo run typecheck build test && ./sandbox standards check
git add packages/sandbox-core/telepresence.ts packages/sandbox-core/telepresence-intercept.test.mjs apps/cli/src/commands/intercept.ts docs/known-issues.md
git commit -m "feat(core): startIntercept and leaveIntercept, callable in-process

The command's fail() ended in process.exit(1), which is why claudeck
still spawns the CLI for POST /intercept — in-process it would take
the express server down. Every failure is now a coded SandboxError,
and the spawn is async so it cannot block a host event loop."
```

---

### Task 4: `test` — the one new module

**Files:**
- Create: `packages/sandbox-core/test_run.ts`
- Modify: `packages/sandbox-core/package.json` (add the `./test_run` export)
- Modify: `apps/cli/src/commands/test.ts` (99 → ~40)
- Test: `packages/sandbox-core/test-run.test.mjs` (create)

**Interfaces:**
- Consumes: `runAsync`, `ProcError` (`./proc.js`), `getSlot` (`./slots.js`),
  `resolveWorkspace`, `sandboxRoot` (`./config.js`), `passthrough` (`./reporter.js`).
- Produces:
```typescript
export function playwrightCwd(workspace: string, root: string): string;
export interface TestRunArgs {
  feature: string; workspace: string; extraArgs?: string[]; signal?: AbortSignal;
}
export interface TestRunResult { status: number; cwd: string; slot: number | null; }
export async function runFeatureTests(a: TestRunArgs): Promise<TestRunResult>;
```
Throws `SandboxError` with code `NPX_MISSING` or `TEST_TIMEOUT`, replacing the two
`process.exit(1)` paths at `apps/cli/src/commands/test.ts:85-95`. A non-zero test
run is **not** an error — it comes back in `result.status` for the CLI to map to an
exit code, because a failing test suite is a result, not a fault.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/test-run.test.mjs`:

```javascript
// The config search decides which directory playwright runs in. Getting it
// wrong runs the wrong suite, or none, and reports success either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { playwrightCwd } from "./dist/test_run.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));

test("prefers the workspace when it holds a playwright config", () => {
  const ws = tmp(), root = tmp();
  fs.writeFileSync(path.join(ws, "playwright.config.ts"), "");
  assert.equal(playwrightCwd(ws, root), ws);
});

test("falls back to the sandbox root when the workspace has no config", () => {
  const ws = tmp(), root = tmp();
  fs.writeFileSync(path.join(root, "playwright.config.js"), "");
  assert.equal(playwrightCwd(ws, root), root);
});

test("falls back to the root when neither has a config", () => {
  assert.equal(playwrightCwd(tmp(), "/some/root"), "/some/root");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test test-run.test.mjs`
Expected: FAIL — `./dist/test_run.js` does not exist.

- [ ] **Step 3: Create the module and register its export**

Create `packages/sandbox-core/test_run.ts` with `playwrightCwd` holding the
config-search loop from `apps/cli/src/commands/test.ts:43-64`, and
`runFeatureTests` holding the rest. Use `runAsync` rather than `procRun` so
`signal` works, and branch on `passthrough()` for the stdio: `true` gives the
child the parent's stdio so playwright's reporter renders natively, `false` pipes.

Add to `packages/sandbox-core/package.json` `exports`:

```json
"./test_run": { "types": "./dist/test_run.d.ts", "default": "./dist/test_run.js" }
```

Copy the exact shape of a neighbouring entry — a missing or malformed entry fails
at runtime, not at compile time.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test test-run.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Reduce the command**

`apps/cli/src/commands/test.ts` keeps its banner, the "not running" warnings, the
`info` lines, the `SandboxError` catch, and
`if (result.status !== 0) process.exit(result.status)`.

- [ ] **Step 6: Smoke the real path**

```bash
./sandbox test demo -- --list
```
Expected: playwright's own output renders exactly as before — colour and all,
which is what the `passthrough()` branch protects. Then Ctrl-C a real run and
confirm no orphaned `playwright` process survives.

- [ ] **Step 7: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/test_run.ts packages/sandbox-core/test-run.test.mjs packages/sandbox-core/package.json apps/cli/src/commands/test.ts
git commit -m "feat(core): runFeatureTests, cancellable and passthrough-aware"
```

---

### Task 5: `open` — the workspace read, not the signal handler

**Files:**
- Modify: `packages/sandbox-core/browser.ts`
- Modify: `apps/cli/src/commands/open.ts` (111 → ~70)
- Test: `packages/sandbox-core/browser-workspace-yaml.test.mjs` (create)

**Interfaces:**
- Consumes: `launchFeatureWindow` (already in `browser.ts`), `featureUrl`
  (`./feature_routing.js`).
- Produces:
```typescript
export function readWorkspaceYaml(workspace: string): Record<string, any>;
```
Takes an explicit workspace path — **not** a `start` directory to walk up from.
The walk-up at `apps/cli/src/commands/open.ts:23-46` is cwd resolution and stays
in the CLI, which calls `findWorkspaceRoot` and then this.

The SIGINT handler at `open.ts:96-108` does **not** move, for the reason its own
comment gives: a library may not install process-wide signal handlers on whoever
imported it, and the MCP server's open-feature tool calls the same launcher while
keeping its own shutdown.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/browser-workspace-yaml.test.mjs`:

```javascript
// Takes a resolved workspace, not a cwd to walk up from: the walk-up is the
// CLI's job, and a remote caller has no meaningful cwd to start one.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readWorkspaceYaml } from "./dist/browser.js";

test("reads .sandbox/workspace.yml from the given workspace", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  fs.mkdirSync(path.join(ws, ".sandbox"));
  fs.writeFileSync(path.join(ws, ".sandbox", "workspace.yml"), "test_path: /checkout\n");
  assert.equal(readWorkspaceYaml(ws).test_path, "/checkout");
});

test("returns an empty object for a missing or malformed file", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  assert.deepEqual(readWorkspaceYaml(ws), {});

  fs.mkdirSync(path.join(ws, ".sandbox"));
  fs.writeFileSync(path.join(ws, ".sandbox", "workspace.yml"), "{{{ not yaml");
  assert.deepEqual(readWorkspaceYaml(ws), {});
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test browser-workspace-yaml.test.mjs`
Expected: FAIL — `readWorkspaceYaml` is not exported.

- [ ] **Step 3: Implement it**

Move `loadWorkspaceYaml`'s body into `browser.ts` as `readWorkspaceYaml(workspace)`,
dropping the walk-up loop and checking both `workspace.yml` and `workspace.yaml`
under `<workspace>/.sandbox/` as today. `yaml` is already a dependency of core
(`generate.ts` uses it) — confirm before importing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test browser-workspace-yaml.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Reduce the command**

`apps/cli/src/commands/open.ts` calls `findWorkspaceRoot(process.cwd())` and passes
the result to `readWorkspaceYaml`. Everything else — the URL resolution, the slot
warning, the SIGINT handler, the exit-code mapping — stays.

- [ ] **Step 6: Smoke the real path**

```bash
./sandbox open demo
```
Expected: the Chrome window opens with the feature badge as before. Ctrl-C it and
confirm the throwaway profile directory is removed:
`ls $TMPDIR | grep chrome-demo` should find nothing.

- [ ] **Step 7: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/browser.ts packages/sandbox-core/browser-workspace-yaml.test.mjs apps/cli/src/commands/open.ts
git commit -m "refactor(core): readWorkspaceYaml takes a workspace, not a cwd"
```

---

### Task 6: Audit `workspace` and `init-workspace`

These two invented the pattern the whole migration generalises: a core function
taking a resolved answer bag, plus a CLI wizard that collects it. This task proves
they meet the contract rather than assuming it.

**Files:**
- Read: `apps/cli/src/commands/workspace.ts`, `apps/cli/src/commands/init_workspace.ts`
- Create: `docs/superpowers/plans/2026-09-04-workspace-verbs-audit.md`

**Interfaces:**
- Consumes: `provisionWorkspace`, `WorkspaceInitError` (`sandbox-core/workspace_init`),
  `buildFormSchema` (`sandbox-core/form_schema`), the prompt-spec exports
  (`sandbox-core/workspace_prompts`).
- Produces: an audit note. No new API.

- [ ] **Step 1: Answer the contract questions for both files**

For each, in writing:
1. Does it hold logic beyond argv, rendering, exit-code mapping, TTY prompting and
   cwd resolution?
2. `grep -n "process.exit" apps/cli/src/commands/{workspace,init_workspace}.ts` —
   is each exit either a `SandboxError`/`WorkspaceInitError` catch or an explicit
   argv-validation failure?
3. `withStdoutToStderr` (`init_workspace.ts:52`) exists so `--print-prompts` can
   emit clean JSON on stdout. Is that still needed now that core is silent by
   default and the reporter is opt-in? If not, note it as removable.

- [ ] **Step 2: Decide on `runBrowserForm`**

`workspace.ts:129-156` spawns a browser form and ends in
`process.exit(result.status)`. Decide and record: does launching a form belong in
this layer at all, or is it a surface concern that should move when the REST/MCP
surface is built? **Record the decision; do not act on it** — it is out of this
plan's scope either way.

- [ ] **Step 3: Write the audit note**

Create `docs/superpowers/plans/2026-09-04-workspace-verbs-audit.md` with the
answers, one short section per file, plus the `runBrowserForm` decision and its
reasoning.

- [ ] **Step 4: Fix only what is clearly wrong**

If Step 1 found a contract violation that is a small, obvious fix (a stray exit, a
formatted string crossing the boundary), fix it here with a test. If it is
larger, record it in the note and stop.

- [ ] **Step 5: Verify and commit**

```bash
npx turbo run typecheck build test && ./sandbox standards check
./sandbox workspace --print-form-schema | head -3   # still clean JSON on stdout
git add docs/superpowers/plans/2026-09-04-workspace-verbs-audit.md
git commit -m "docs: audit the workspace verbs against the core contract"
```

---

### Task 7: Close out the migration

**Files:**
- Modify: `docs/known-issues.md`
- Modify: `docs/superpowers/specs/2026-09-04-command-logic-to-core-design.md` (status line)

- [ ] **Step 1: Prove the boundary claim**

```bash
grep -rn "readline\|isTTY\|@inquirer\|process\.cwd()" packages/sandbox-core/*.ts | grep -v "\.test\.\|\.smoke\."
```
Expected: no hits, or only hits you can justify in writing. `process.cwd()` inside
a default-argument fallback is still a violation of §7 — if one exists, fix it or
record why it stands.

```bash
grep -rn "process.exit" apps/cli/src/commands/*.ts | grep -v setup.ts | grep -v config.ts
```
Expected: every remaining exit is inside a `SandboxError` catch or an explicit
argv/gate failure branch.

- [ ] **Step 2: Update `docs/known-issues.md`**

Rewrite the "Claudeck's Streaming Routes Still Spawn the CLI" entry: both stated
blockers are gone — `/action`'s was the `AbortSignal` decision (Plan 1 Task 3),
`/intercept`'s was the missing core entry point (Task 3 here). Change its status
from `Open — deferred, blocked on two decisions` to
`Open — unblocked; the claudeck routes have not been moved yet`, and say that
moving them is a claudeck change, deliberately out of the migration's scope.

Also correct the entry's aside that `getIntercepts()`'s telepresence reads are
`spawnSync` — after Task 3 the intercept path has an async runner, though
`listIntercepts` and `connectedNamespace` still use `_run`. State exactly which
are which; a half-true note is worse than none.

- [ ] **Step 3: Update the spec's status line**

Change `**Status:** approved; not yet started` to
`**Status:** approved; all tiers shipped` with the date, and add a short
"Where this stands" paragraph after §1 the way the predecessor spec did — the next
cold reader needs to know it is done, not planned.

- [ ] **Step 4: Full verification**

```bash
npx turbo run typecheck build test
./sandbox standards check
./sandbox status
node --input-type=module -e '
  const { getK8sForwardsHealth, listWorkspaces } = await import("sandbox-core");
  const { workspacesRoot } = await import("sandbox-core/config");
  const h = await getK8sForwardsHealth();
  console.log(workspacesRoot(), `${h.healthy}/${h.total}`);
  console.log((await listWorkspaces()).workspaces.map(w => w.name).join(", "));
'
```
Expected: everything green, and the CLI and library agree.

- [ ] **Step 5: Commit**

```bash
git add docs/known-issues.md docs/superpowers/specs/2026-09-04-command-logic-to-core-design.md
git commit -m "docs: record the command migration as shipped

Both claudeck blockers are gone: /action's was the AbortSignal
decision, /intercept's was the missing core entry point. Moving those
routes is a claudeck change and stays out of scope."
```

---

## Done when

- No `readline`, `isTTY`, `@inquirer` or `process.cwd()` in `packages/sandbox-core`.
- `startIntercept`/`leaveIntercept` exist and throw coded `SandboxError`s.
- Ctrl-C during `sandbox test` and `sandbox logs` leaves no orphaned child.
- The SessionStart hook's context output is byte-identical to before Task 1.
- Both audit notes exist.
- `npx turbo run typecheck build test` and `./sandbox standards check` pass.
