# Command Logic to Core — Plan 1: Foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the one wrong import edge in the command tree, and build the
cancellation path the other two plans depend on.

**Architecture:** `packages/sandbox-core` is a TypeScript library the CLI
(`apps/cli`) consumes. Every subprocess call in core today goes through
`proc.run`, which is `spawnSync` — synchronous, and therefore uncancellable. This
plan adds an async sibling that honours an `AbortSignal`, threads it through the
compose calls that can run for minutes, and gives the CLI an `AbortController`
driven by SIGINT. Nothing user-visible changes.

**Tech Stack:** TypeScript, Node ≥20 (`node:child_process`, `node:async_hooks`),
`node:test` + `assert/strict` for core, vitest for the CLI, turbo for the workspace.

**Spec:** `docs/superpowers/specs/2026-09-04-command-logic-to-core-design.md`

## Global Constraints

- **CLI output must not change.** A rendering change makes every regression
  invisible. This whole plan is behaviour-preserving.
- **No `process.exit` below `apps/cli/src/main.ts`.** Library failures throw
  `SandboxError` from `sandbox-core/errors` with a `code`.
- **No `console.*` in core for progress.** Use `info`/`success`/`warn`/`error`/`raw`
  from `sandbox-core/reporter`. Two writes are deliberate exceptions and must be
  left alone: `packages/sandbox-core/gate.ts:292` (hook JSON protocol output) and
  `packages/sandbox-core/cache.ts:79,96` (stderr diagnostics for consumers that
  install no reporter).
- **Core tests** are `packages/sandbox-core/*.test.mjs`, written with `node:test`
  and `assert/strict`, and they import from `./dist/<module>.js` — the `test`
  script runs `tsc` first. **CLI tests** are vitest under
  `apps/cli/src/commands/__tests__/`.
- **Every new core module needs an `exports` entry** in
  `packages/sandbox-core/package.json`. A module without one is unimportable by
  subpath and the failure is a runtime resolution error, not a compile error.
- Verification for every task: `npx turbo run typecheck build test` from the repo
  root, and `./sandbox standards check`.
- Conventional commits (`refactor(core): …`). Never commit to `main`.
- **Two pre-existing flakes will bite a full `turbo run … test` under load.**
  Neither is caused by this work; do not chase them. `wrapper_npx.test.ts` shells
  out to a real `npm install -g` under a 5s vitest budget (1.6s standalone, >5s
  under twelve concurrent turbo tasks), and `cache.smoke.mjs:43` waits a fixed
  `sleep(50)` for a background refresh. Re-run, or run the failing package alone,
  before believing a red.

---

### Task 1: Delete the duplicate `findWorkspaceRoot`

`apps/cli/src/commands/notes.ts:67` and `packages/sandbox-core/gate.ts:85` are the
same walk-up written twice. `apps/cli/src/commands/skills.ts:22` imports it from
`./notes.js` — the only command-to-command import edge in the tree.

**Files:**
- Modify: `apps/cli/src/commands/notes.ts` (delete lines 60-83, add an import)
- Modify: `apps/cli/src/commands/skills.ts:22`
- Test: `apps/cli/src/commands/__tests__/notes_context.test.ts` (exists; must still pass)

**Interfaces:**
- Consumes: `findWorkspaceRoot(start: string): string | null` from `sandbox-core/gate`
- Produces: nothing new. `commands/notes.ts` stops exporting `findWorkspaceRoot`.

- [ ] **Step 1: Confirm the two implementations agree before deleting one**

Write `packages/sandbox-core/gate.test.mjs` (append if it exists):

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findWorkspaceRoot } from "./dist/gate.js";

test("findWorkspaceRoot walks up to the nearest .sandbox directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const nested = path.join(root, "repo", "src");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, ".sandbox"));

  assert.equal(findWorkspaceRoot(nested), fs.realpathSync(root));
  assert.equal(findWorkspaceRoot(root), fs.realpathSync(root));
});

test("findWorkspaceRoot returns null when no .sandbox exists above start", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bare-"));
  assert.equal(findWorkspaceRoot(bare), null);
});
```

Note: `fs.realpathSync` on the expectation because macOS `os.tmpdir()` is a
symlink into `/private/var` and `path.resolve` inside the function does not
resolve it. If the assertion still fails, compare `fs.realpathSync` on both sides.

- [ ] **Step 2: Run it and watch it pass**

Run: `cd packages/sandbox-core && npx tsc && node --test gate.test.mjs`
Expected: PASS. This is a characterisation test — it pins the behaviour the CLI
copy currently provides, so deleting that copy is provably safe.

- [ ] **Step 3: Delete the CLI copy**

In `apps/cli/src/commands/notes.ts`, delete the whole block from the docstring at
line 60 through the closing brace of `findWorkspaceRoot` at line 83, and add to
the import block:

```typescript
import { findWorkspaceRoot } from "sandbox-core/gate";
```

Leave the three call sites (`notes.ts:285`, `notes.ts:380`, and the one inside
`run`) untouched — they now resolve to the imported function.

- [ ] **Step 4: Re-point `skills.ts`**

In `apps/cli/src/commands/skills.ts`, replace line 22:

```typescript
import { findWorkspaceRoot } from "./notes.js";
```

with:

```typescript
import { findWorkspaceRoot } from "sandbox-core/gate";
```

- [ ] **Step 5: Prove no command-to-command imports remain**

Run: `grep -rn 'from "\./[a-z_]*\.js"' apps/cli/src/commands/*.ts`
Expected: only `up.ts`'s dynamic `import("./connect.js")` (a deliberate
re-dispatch documented in that file) and `workspace.ts`'s import from
`./init_workspace.js` (the shared wizard adapter, which stays). No `notes.js`
import from `skills.ts`.

- [ ] **Step 6: Full verification**

Run: `npx turbo run typecheck build test`
Expected: all tasks pass. `notes_context.test.ts` exercises `buildContext`, which
calls `findWorkspaceRoot` — if it passes, the swap is behaviour-identical.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/gate.test.mjs apps/cli/src/commands/notes.ts apps/cli/src/commands/skills.ts
git commit -m "refactor(cli): drop the duplicate findWorkspaceRoot

commands/skills.ts imported it from commands/notes.ts — the only
command-to-command import edge in the tree — and the implementation
was a second copy of the walk-up already in sandbox-core/gate."
```

---

### Task 2: An async, cancellable spawn in `proc.ts`

`proc.run` is `spawnSync`. A synchronous spawn cannot be aborted and blocks the
event loop for its whole duration, so `AbortSignal` support is a new code path,
not a new parameter. This task adds the sibling; Task 3 uses it.

**Status: done** (commit follows). Two corrections found while implementing, both
now in the shipped test file:

- The four tests below **pass even when `signal` is never handed to `spawn`** —
  they just take 60s, because the abort verdict is derived from
  `opts.signal.aborted` and the child exits on its own. Promptness is the actual
  contract, so the shipped tests assert an elapsed bound. Verified by mutation.
- The orphan test raced the child's stdout flush against a fixed sleep and failed
  under turbo's concurrency. The shipped version passes the pid through a file
  and polls, so there is no race to lose.

**Files:**
- Modify: `packages/sandbox-core/proc.ts`
- Test: `packages/sandbox-core/proc.test.mjs` (create)

**Interfaces:**
- Consumes: `RunOptions`, `RunResult`, `ProcError` — all already exported from
  `packages/sandbox-core/proc.ts`.
- Produces: `runAsync(cmd: string[], opts?: AsyncRunOptions): Promise<RunResult>`
  where `AsyncRunOptions = RunOptions & { signal?: AbortSignal }`. On abort it
  rejects with a `ProcError` whose `code` is `"ABORT_ERR"`. Task 3 and plans 2
  and 3 depend on exactly these names.

- [x] **Step 1: Write the failing tests**

Create `packages/sandbox-core/proc.test.mjs`:

```javascript
// `proc.run` is spawnSync and cannot be cancelled, so every long-running core
// path needs this async sibling. The abort contract is what a remote caller
// gets instead of killing the CLI process.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runAsync, ProcError } from "./dist/proc.js";

test("runAsync captures stdout and the exit status", async () => {
  const res = await runAsync(["node", "-e", "process.stdout.write('hi')"], { capture: true });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "hi");
});

test("runAsync rejects with ABORT_ERR when the signal fires", async () => {
  const ac = new AbortController();
  const promise = runAsync(["node", "-e", "setTimeout(() => {}, 60000)"], {
    capture: true,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50);

  const err = await promise.then(() => null, (e) => e);
  assert.ok(err instanceof ProcError, `expected ProcError, got ${err}`);
  assert.equal(err.code, "ABORT_ERR");
});

test("runAsync rejects with ENOENT for a missing executable", async () => {
  const err = await runAsync(["definitely-not-a-real-binary-xyz"], { capture: true })
    .then(() => null, (e) => e);
  assert.ok(err instanceof ProcError);
  assert.equal(err.code, "ENOENT");
});

test("runAsync throws on non-zero status only when check is set", async () => {
  const res = await runAsync(["node", "-e", "process.exit(3)"], { capture: true });
  assert.equal(res.status, 3);

  const err = await runAsync(["node", "-e", "process.exit(3)"], { capture: true, check: true })
    .then(() => null, (e) => e);
  assert.ok(err instanceof ProcError);
  assert.equal(err.status, 3);
});
```

- [x] **Step 2: Run and watch them fail**

Run: `cd packages/sandbox-core && npx tsc && node --test proc.test.mjs`
Expected: FAIL — `runAsync` is not exported from `./dist/proc.js`.

- [x] **Step 3: Implement `runAsync`**

Append to `packages/sandbox-core/proc.ts`, and add `spawn` to the existing
`node:child_process` import so the first line reads
`import { spawn, spawnSync } from "node:child_process";`:

```typescript
export interface AsyncRunOptions extends RunOptions {
  /**
   * Aborting kills the child with SIGTERM and rejects with a ProcError whose
   * `code` is "ABORT_ERR". A synchronous `run` has no equivalent, which is the
   * whole reason this function exists.
   */
  signal?: AbortSignal;
}

/**
 * The async, cancellable sibling of {@link run}.
 *
 * Same options and the same ProcError contract, plus `signal`. Use it for
 * anything that can run for more than a moment — compose, playwright,
 * telepresence — so a caller that is not a dying CLI process can still stop it.
 */
export function runAsync(cmd: string[], opts: AsyncRunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdio: ("pipe" | "inherit")[] = opts.capture
      ? ["pipe", "pipe", "pipe"]
      : ["inherit", "inherit", "inherit"];
    if (opts.input !== undefined) stdio[0] = "pipe";

    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio,
      signal: opts.signal,
      timeout: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }

    child.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ABORT_ERR") {
        reject(new ProcError(`Command aborted: ${cmd.join(" ")}`, cmd, -1, stdout, stderr, "ABORT_ERR"));
        return;
      }
      if (code === "ENOENT") {
        reject(new ProcError(`Command not found: ${cmd[0]}`, cmd, -1, stdout, stderr, "ENOENT"));
        return;
      }
      reject(new ProcError(`Command failed to start: ${cmd.join(" ")} (${e.message})`, cmd, -1, stdout, stderr, code));
    });

    child.on("close", (status, signal) => {
      // A timeout kills with SIGTERM and reports a null status, which is
      // indistinguishable from an abort by exit code alone — the "error" event
      // above has already rejected the abort case by the time we get here.
      if (status === null && signal) {
        reject(new ProcError(
          `Command timed out after ${opts.timeout}s: ${cmd.join(" ")}`,
          cmd, -1, stdout, stderr, "ETIMEDOUT",
        ));
        return;
      }
      const code = status ?? -1;
      if (opts.check && code !== 0) {
        reject(new ProcError(
          `Command failed with exit code ${code}: ${cmd.join(" ")}`,
          cmd, code, stdout, stderr,
        ));
        return;
      }
      resolve({ status: code, stdout, stderr });
    });
  });
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test proc.test.mjs`
Expected: PASS, 4 tests.

If the abort test hangs: Node rejects an aborted `spawn` through the `error`
event, and both `error` and `close` can fire. The promise settles once, so the
second call is a no-op — but confirm the child is actually gone with
`ps aux | grep 'setTimeout'` before assuming the test is wrong.

- [x] **Step 5: Full verification**

Run: `npx turbo run typecheck build test`
Expected: all pass. `run` is untouched, so nothing else can regress.

- [x] **Step 6: Commit**

```bash
git add packages/sandbox-core/proc.ts packages/sandbox-core/proc.test.mjs
git commit -m "feat(core): add runAsync, a cancellable sibling of proc.run

proc.run is spawnSync: it cannot be aborted and blocks the event loop
for the child's whole life. Every long-running core path needs a
signal a caller that is not a dying CLI process can pull."
```

---

### Task 3: Thread `signal` through compose and lifecycle

The six verbs that spawn or stream are `up`, `down`, `test`, `logs`, `intercept`,
`connect`. `up` and `down` reach `docker compose` through `runCompose` in
`packages/sandbox-core/compose.ts`; this task gives them the path. `test`,
`logs` and `intercept` are handled in plans 2 and 3, which consume what this
task produces.

**Status: done** (commit follows). One change from the sketch below: rather than
duplicating `runCompose`'s body, its eight messages were extracted into three
shared helpers (`composeCommand`, `reportComposeOutcome`, `reportComposeFailure`)
that both the sync and async paths call. Each message now exists exactly once, so
the two spellings cannot drift -- which is a stronger guarantee than a diff.
`lifecycle_down.test.ts`'s mock target moved from `composeDown` to
`composeDownAsync`; its assertions are unchanged.

**Files:**
- Modify: `packages/sandbox-core/compose.ts` (`runCompose`, `composeUp`, `composeDown`)
- Modify: `packages/sandbox-core/lifecycle.ts` (`up`, `down`)
- Test: `packages/sandbox-core/compose-abort.test.mjs` (create)

**Interfaces:**
- Consumes: `runAsync`, `AsyncRunOptions`, `ProcError` from `sandbox-core/proc` (Task 2).
- Produces:
  - `composeUpAsync(feature: string, signal?: AbortSignal): Promise<boolean>`
  - `composeDownAsync(feature: string, opts?: { removeVolumes?: boolean; signal?: AbortSignal }): Promise<boolean>`
  - `up(feature: string, workspace: string, opts?: { signal?: AbortSignal }): Promise<UpResult>`
  - `down(feature: string, opts?: { removeVolumes?: boolean; signal?: AbortSignal }): Promise<DownResult>`

  The existing synchronous `composeUp`/`composeDown` stay exported and unchanged.
  Plans 2 and 3 rely on both spellings existing.

- [x] **Step 1: Write the failing test**

Create `packages/sandbox-core/compose-abort.test.mjs`:

```javascript
// The abort path is the contract a remote caller gets in place of killing the
// CLI. Pinned at the compose layer because that is where the minutes are spent.
import { test } from "node:test";
import assert from "node:assert/strict";

import { composeUpAsync } from "./dist/compose.js";

test("composeUpAsync resolves false for an already-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(await composeUpAsync("no-such-feature-hopefully", ac.signal), false);
});
```

Note this asserts `false`, not a throw: `composeUp` returns a boolean today and
`lifecycle.up` branches on it. Preserving that contract is what keeps CLI output
identical.

- [x] **Step 2: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test compose-abort.test.mjs`
Expected: FAIL — `composeUpAsync` is not exported.

- [x] **Step 3: Add the async compose path**

In `packages/sandbox-core/compose.ts`, add `runAsync` to the existing import from
`./proc.js`, then add beside `runCompose`:

```typescript
/**
 * The cancellable sibling of {@link runCompose}. Same null-on-failure contract:
 * a missing compose file, a missing docker binary, a timeout and an abort all
 * return null, because every caller treats them the same way — as "did not run".
 */
async function runComposeAsync(
  feature: string,
  args: string[],
  opts: { capture?: boolean; signal?: AbortSignal } = {},
): Promise<RunResult | null> {
  const composePath = composeFile(feature);
  if (composePath === null || !isFile(composePath)) {
    return null;
  }
  try {
    return await runAsync(["docker", "compose", "-f", composePath, ...args], {
      capture: opts.capture,
      signal: opts.signal,
      timeout: 300,
    });
  } catch (err) {
    if (err instanceof ProcError && err.code === "ABORT_ERR") {
      warn(`docker compose for '${feature}' was cancelled`);
      return null;
    }
    if (err instanceof ProcError && err.code === "ENOENT") {
      error("docker not found on PATH");
      return null;
    }
    if (err instanceof ProcError && err.code === "ETIMEDOUT") {
      error("docker compose timed out after 5 minutes");
      return null;
    }
    throw err;
  }
}

/** Cancellable {@link composeUp}. */
export async function composeUpAsync(feature: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runComposeAsync(
    feature,
    ["up", "-d", "--build", "--remove-orphans"],
    { capture: true, signal },
  );
  if (result && result.status === 0) {
    success(`Containers for '${feature}' are up`);
    return true;
  }
  return false;
}

/** Cancellable {@link composeDown}. */
export async function composeDownAsync(
  feature: string,
  { removeVolumes = false, signal }: { removeVolumes?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  const composePath = composeFile(feature);
  if (composePath === null || !isFile(composePath)) {
    return true;
  }
  const args = ["down", "--remove-orphans"];
  if (removeVolumes) {
    args.push("--volumes");
  }
  const result = await runComposeAsync(feature, args, { capture: true, signal });
  return result !== null && result.status === 0;
}
```

Check the existing `runCompose` for the exact error-branch wording and the exact
`down` argument list, and copy them verbatim — the messages are CLI output and
the Global Constraints forbid changing them. Verify `warn` is in the module's
import from `./reporter.js`; add it if not.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test compose-abort.test.mjs`
Expected: PASS.

- [x] **Step 5: Accept and forward the signal in `lifecycle`**

In `packages/sandbox-core/lifecycle.ts`, widen the two signatures and forward:

```typescript
export async function up(
  feature: string,
  workspace: string,
  opts: { signal?: AbortSignal } = {},
): Promise<UpResult>

export async function down(
  feature: string,
  opts: { removeVolumes?: boolean; signal?: AbortSignal } = {},
): Promise<DownResult>
```

Inside each, replace the `composeUp(feature)` / `composeDown(feature, …)` call
with `await composeUpAsync(feature, opts.signal)` /
`await composeDownAsync(feature, { removeVolumes: opts.removeVolumes, signal: opts.signal })`.
`down`'s existing `removeVolumes` option keeps its current name and meaning — read
the current signature at `lifecycle.ts:358` and preserve it exactly; the CLI's
`down.test.ts` asserts `down` is called with `{ removeVolumes: true }`.

- [x] **Step 6: Full verification**

Run: `npx turbo run typecheck build test`
Expected: all pass, including `apps/cli/src/commands/__tests__/down.test.ts` and
`up.test.ts` **unchanged**. If either fails, the signature widening broke a call
shape — fix the library, not the test.

- [x] **Step 7: Smoke the real path**

Run: `./sandbox status`
Then Ctrl-C a `./sandbox up <some-feature>` mid-build and confirm no orphaned
`docker compose` process survives: `ps aux | grep 'docker compose'`.

- [x] **Step 8: Commit**

```bash
git add packages/sandbox-core/compose.ts packages/sandbox-core/lifecycle.ts packages/sandbox-core/compose-abort.test.mjs
git commit -m "feat(core): make the compose path in up and down cancellable

A remote caller cannot kill the CLI process to stop a wedged
docker compose. up and down now take an optional AbortSignal and
forward it to an async compose spawn; the sync spellings stay."
```

---

### Task 4: Give the CLI an `AbortController` driven by SIGINT

`apps/cli/src/lib/interrupt.ts` already decides who owns Ctrl-C, but it has no
`AbortController`. This gives it one and hands the signal to `main.ts`'s dispatch,
so the CLI is the first consumer of what Task 3 built.

**Files:**
- Modify: `apps/cli/src/lib/interrupt.ts`
- Modify: `apps/cli/src/main.ts` (the `withReporter(ttyReporter, …)` dispatch wrap)
- Modify: `apps/cli/src/commands/up.ts`, `apps/cli/src/commands/down.ts`
- Test: `apps/cli/src/lib/__tests__/interrupt.test.ts` (create, or extend if present)

**Interfaces:**
- Consumes: `up`/`down` with `opts.signal` (Task 3).
- Produces: `interruptSignal(): AbortSignal` exported from
  `apps/cli/src/lib/interrupt.ts`, aborted on the first SIGINT. Plans 2 and 3
  pass this into `test`, `logs`, `intercept` and `connect`.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/lib/__tests__/interrupt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { installDefaultInterrupt, interruptSignal } from "../interrupt.js";

describe("interruptSignal", () => {
  it("is unaborted before any signal and aborted after SIGINT", () => {
    const proc = new EventEmitter();
    installDefaultInterrupt(proc, () => {}, () => {});

    const signal = interruptSignal();
    expect(signal.aborted).toBe(false);

    proc.emit("SIGINT");
    expect(signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/cli && npx vitest run src/lib/__tests__/interrupt.test.ts`
Expected: FAIL — `interruptSignal` is not exported.

- [ ] **Step 3: Implement it**

In `apps/cli/src/lib/interrupt.ts`, add a module-level controller and abort it
from inside `installDefaultInterrupt`'s SIGINT listener, **before** the existing
render/exit calls:

```typescript
const controller = new AbortController();

/**
 * The signal every cancellable core call gets.
 *
 * Aborted on the first SIGINT, before the default handler renders or exits, so
 * a command that claimed the interrupt still sees the abort propagate into
 * whatever core call it is awaiting.
 */
export function interruptSignal(): AbortSignal {
  return controller.signal;
}
```

Read `installDefaultInterrupt`'s existing body first: it decides whether to act
based on `claimed(proc)`. The `controller.abort()` call goes **outside** that
check — a command that claims the interrupt still wants its core call cancelled,
it just wants to do its own cleanup and exit.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/cli && npx vitest run src/lib/__tests__/interrupt.test.ts`
Expected: PASS.

- [ ] **Step 5: Pass the signal from the two commands that can use it now**

In `apps/cli/src/commands/up.ts`, change the final call:

```typescript
printSummary(await upFeature(feature, workspace, { signal: interruptSignal() }));
```

In `apps/cli/src/commands/down.ts`, find the `downFeature(...)` call inside
`teardown` and add `signal: interruptSignal()` to its options object, preserving
the existing `removeVolumes` key. Add
`import { interruptSignal } from "../lib/interrupt.js";` to both files.

- [ ] **Step 6: Full verification**

Run: `npx turbo run typecheck build test`
Expected: all pass. `down.test.ts` asserts `down` is called with
`{ removeVolumes: true }` — it will now also carry `signal`, so if the assertion
is an exact-object match it needs
`expect.objectContaining({ removeVolumes: true })`. Update the assertion; do not
weaken what it checks about `removeVolumes`.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/lib/interrupt.ts apps/cli/src/lib/__tests__/interrupt.test.ts apps/cli/src/main.ts apps/cli/src/commands/up.ts apps/cli/src/commands/down.ts
git commit -m "feat(cli): derive an AbortSignal from SIGINT and pass it to core

interrupt.ts already owned who handles Ctrl-C but had no controller.
up and down now hand core a signal, making the CLI the first consumer
of the cancellation path."
```

---

### Task 5: Audit the six tier-0 verbs against the contract

`up`, `stop`, `restart`, `status`, `connect` and `hooks` were migrated by the
predecessor's row 5. This task proves they obey §3 of the spec rather than
assuming it, and records anything they don't.

**Files:**
- Read: `apps/cli/src/commands/{up,stop,restart,status,connect,hooks}.ts`
- Modify: `apps/cli/src/commands/connect.ts` (signal only)
- Create: `docs/superpowers/plans/2026-09-04-tier-0-audit.md`

**Interfaces:**
- Consumes: `interruptSignal()` (Task 4), `infra.up` from `sandbox-core/infra`.
- Produces: an audit note listing any tier-0 verb that violates the contract, for
  plans 2 and 3 to absorb. No new API.

- [ ] **Step 1: Check each of the six for contract violations**

For each file, answer in writing:
1. Does it hold any logic beyond argv mapping, rendering, exit-code mapping, TTY
   prompting and cwd resolution?
2. Does its core call return data, or pre-formatted strings?
3. Does any `process.exit` sit outside the catch-own-code hint pattern?

Run to find the exits: `grep -n "process.exit" apps/cli/src/commands/{up,stop,restart,status,connect,hooks}.ts`

Expected, from the spec's §5: all six are clean. `connect.ts` keeps its three
hardcoded `tools.local.sandbox.com` URLs deliberately — that is rendering, not a
violation. If you find anything else, do not fix it here; record it.

- [ ] **Step 2: Add the signal to `connect`**

In `apps/cli/src/commands/connect.ts`, pass `interruptSignal()` into `infraUp()`.
This requires widening `up()` in `packages/sandbox-core/infra.ts` to take
`opts: { signal?: AbortSignal } = {}` and forwarding it the same way Task 3 did
for `lifecycle.up`. Read `infra.ts`'s `up()` first to find its compose calls.

- [ ] **Step 3: Write the audit note**

Create `docs/superpowers/plans/2026-09-04-tier-0-audit.md` with one section per
verb, each recording the three answers from Step 1. Where a verb is clean, say so
in one line. Where it is not, state the violation and which of plans 2 or 3 should
absorb it.

- [ ] **Step 4: Full verification**

Run: `npx turbo run typecheck build test` and `./sandbox standards check`
Expected: all pass.

- [ ] **Step 5: Smoke both paths and confirm they agree**

```bash
./sandbox status
node --input-type=module -e '
  const { getK8sForwardsHealth, listWorkspaces } = await import("sandbox-core");
  const { workspacesRoot } = await import("sandbox-core/config");
  const h = await getK8sForwardsHealth();
  console.log(workspacesRoot(), `${h.healthy}/${h.total}`,
    h.forwards.map(f => `${f.name}:${f.port}`).join(" "));
  console.log((await listWorkspaces()).workspaces.map(w => w.name).join(", "));
'
```

Expected: the forward counts and workspace names match between the two. That
agreement is the whole point of the migration.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-09-04-tier-0-audit.md packages/sandbox-core/infra.ts apps/cli/src/commands/connect.ts
git commit -m "refactor(core): make connect cancellable, audit the tier-0 verbs

The six verbs row 5 migrated are checked against the contract rather
than assumed to meet it; findings recorded for plans 2 and 3."
```

---

## Done when

- `grep -rn 'findWorkspaceRoot' apps/cli/src/commands/` shows imports from
  `sandbox-core/gate` and no local definition.
- `runAsync` exists with the four tested behaviours, and `up`, `down` and
  `connect` accept and forward a signal.
- Ctrl-C during `sandbox up` leaves no orphaned `docker compose` process.
- `npx turbo run typecheck build test` and `./sandbox standards check` pass.
- The tier-0 audit note exists and either reports six clean verbs or names what
  plans 2 and 3 must absorb.

**Next:** Plan 2 (`…-2-tier-1.md`) — the ten mechanical verb lifts.
