# Command Logic to Core — Plan 2: The Ten Mechanical Lifts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the orchestration of ten verbs out of `apps/cli/src/commands` into
`packages/sandbox-core`, leaving argv mapping and rendering behind.

**Architecture:** Each task follows one recipe: define a typed args/result pair in
the domain module that already owns the verb's callees, move the sequencing into
it, swap `process.exit` for `SandboxError`, and reduce the command to a call plus
its printers. Every callee these verbs use is already in core, so no task here
needs a new dependency or an unresolved decision.

**Tech Stack:** TypeScript, `node:test` + `assert/strict` for core, vitest for the
CLI, turbo for the workspace.

**Spec:** `docs/superpowers/archive/specs/2026-09-04-command-logic-to-core-design.md` (§5, tier 1)

**Depends on:** Plan 1 (`…-1-foundations.md`). Tasks 8 (`logs`) and 9 (`stats`)
both need `interruptSignal()` from Plan 1 Task 4; the other eight need nothing
from it.

## Global Constraints

- **CLI output must not change.** Before lifting any verb, capture its current
  output (`./sandbox <verb> … > /tmp/<verb>.before 2>&1`), and diff after. The
  banner lines, `Colors` usage, `padEnd` widths and blank lines are all part of
  the contract.
- **No `process.exit` below `apps/cli/src/main.ts`.** Throw `SandboxError` from
  `sandbox-core/errors` with a `code`. Where a hint must print *between* the error
  line and the exit, the command catches its own code and reports — see
  `apps/cli/src/commands/restart.ts` for the pattern.
- **No `console.*` in core for progress.** Use `info`/`success`/`warn`/`error`/`raw`
  from `sandbox-core/reporter`. Leave `gate.ts:292` and `cache.ts:79,96` alone —
  both are deliberate, documented exceptions.
- **Core imports config from `./config.js`,** not from `apps/cli/src/lib/config.js`.
  That CLI file is a pure re-export door; `loadServices`, `loadPorts`,
  `resolveWorkspace`, `getVolumeBaseNames` and `getK8sContext` all live in
  `packages/sandbox-core/config.ts`.
- **A result is data.** No `Colors`, no `padEnd`, no pre-formatted strings crossing
  the boundary.
- **Every new core module needs an `exports` entry** in
  `packages/sandbox-core/package.json`. No task here adds one — all ten land in
  existing modules — so if you find yourself creating a file, re-read §4 of the spec.
- Verification for every task: `npx turbo run typecheck build test` and
  `./sandbox standards check`.
- Conventional commits. Never commit to `main`.

**Tasks are independent.** There is no ordering constraint among the ten; do them
in any order, or in parallel across agents.

---

### Task 1: `services`

**Files:**
- Modify: `packages/sandbox-core/slots.ts`
- Modify: `apps/cli/src/commands/services.ts` (83 lines → ~40, all rendering)
- Test: `packages/sandbox-core/slots-services.test.mjs` (create)

**Interfaces:**
- Consumes: `getSlot`, `getAllSlots`, `getServicePort` (already in `slots.ts`);
  `loadServices` from `./config.js`.
- Produces:
```typescript
export interface ServiceEndpoint {
  service: string;
  source: "local" | "k8s" | "none";
  endpoint: string | null;   // null when source is "none"
  type: string;              // svcDef.type, or "unknown"
}
export interface FeatureServices { feature: string; slot: number; endpoints: ServiceEndpoint[]; }
export async function featureServices(feature: string): Promise<FeatureServices>;
```
Throws `SandboxError(…, "NOT_RUNNING")` when the feature has no slot.

- [ ] **Step 1: Capture current output**

```bash
./sandbox up demo 2>/dev/null || true
./sandbox services demo > /tmp/services.before 2>&1
cat /tmp/services.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/slots-services.test.mjs`:

```javascript
// The local-vs-k8s endpoint decision was the only logic in commands/services.ts.
// It is pinned here so the CLI is left holding nothing but padEnd.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyEndpoint } from "./dist/slots.js";

test("a locally-running service reports its slot port", () => {
  const e = classifyEndpoint("backend", { port_offset: 2, type: "api" }, ["backend"], 3);
  assert.equal(e.source, "local");
  assert.equal(e.type, "api");
  assert.match(e.endpoint, /^localhost:\d+$/);
});

test("a service not running locally falls back to its k8s forward port", () => {
  const e = classifyEndpoint("redis", { k8s_forward_port: 9050, type: "cache" }, [], 3);
  assert.deepEqual(
    { source: e.source, endpoint: e.endpoint },
    { source: "k8s", endpoint: "localhost:9050" },
  );
});

test("a service with neither a local container nor a forward is unconfigured", () => {
  const e = classifyEndpoint("ghost", { type: "api" }, [], 3);
  assert.equal(e.source, "none");
  assert.equal(e.endpoint, null);
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test slots-services.test.mjs`
Expected: FAIL — `classifyEndpoint` is not exported.

- [ ] **Step 4: Implement in `slots.ts`**

Export `classifyEndpoint(service, svcDef, localServices, slot): ServiceEndpoint`
holding the three-branch decision now at `apps/cli/src/commands/services.ts:52-67`,
and `featureServices(feature)` that resolves the slot, reads `getAllSlots()` for
the feature's local service list, and maps every key of `loadServices()` through
it, sorted. Keep the `"(not configured)"` string **in the CLI** — it is display
text for the `null` endpoint.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test slots-services.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Reduce the command to rendering**

`apps/cli/src/commands/services.ts` calls `featureServices(feature)`, catches
`SandboxError` with code `NOT_RUNNING` to print the existing
`Feature 'x' is not running (no slot allocated)` warning plus the
`Start it with: sandbox up <feature>` hint, and otherwise renders the table
exactly as today. The `Colors` and `padEnd` code moves nowhere.

- [ ] **Step 7: Diff the output**

```bash
./sandbox services demo > /tmp/services.after 2>&1
diff /tmp/services.before /tmp/services.after && echo IDENTICAL
```
Expected: `IDENTICAL`. Any diff is a bug in the lift, not an improvement.

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/slots.ts packages/sandbox-core/slots-services.test.mjs apps/cli/src/commands/services.ts
git commit -m "refactor(core): move the services endpoint resolution into slots"
```

---

### Task 2: `remove`

**Files:**
- Modify: `packages/sandbox-core/lifecycle.ts`
- Modify: `apps/cli/src/commands/remove.ts` (95 → ~35)
- Test: `packages/sandbox-core/lifecycle-remove.test.mjs` (create)

**Interfaces:**
- Consumes: `composeUp`/`composeDown` (`./compose.js`), `generateFeatureCompose`,
  `generateFeatureEnv`, `generateSupergraphConfig`, `generateCaddyfile`
  (`./generate.js`), `isCaddyRunning`, `reloadCaddy` (`./caddy.js`),
  `getSlot`/`getAllSlots` (`./slots.js`).
- Produces:
```typescript
export interface RemoveResult {
  feature: string;
  removed: string;
  remaining: string[];       // sorted
  containersStopped: boolean; // true when no local services remained
  proxyReloaded: boolean;
}
export async function removeService(feature: string, service: string): Promise<RemoveResult>;
```
Throws `SandboxError(…, "NOT_RUNNING")` when the feature has no slot, and
`SandboxError(…, "NOT_LOCAL")` when the service is not one of its local services.
The second replaces today's early `return` after a `warn`, so the command must
catch `NOT_LOCAL` and print the same warning plus the local-services line.

- [ ] **Step 1: Capture current output**

```bash
./sandbox remove demo backend > /tmp/remove.before 2>&1; cat /tmp/remove.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/lifecycle-remove.test.mjs`:

```javascript
// removeService is a six-step sequence — regenerate three configs, restart or
// stop containers, regenerate the Caddyfile, reload — and until now it existed
// only inside a command module. The order is the contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxError } from "./dist/errors.js";
import { removeService } from "./dist/lifecycle.js";

test("removing from a feature with no slot raises NOT_RUNNING", async () => {
  const err = await removeService("no-such-feature-hopefully", "backend")
    .then(() => null, (e) => e);
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_RUNNING");
});
```

The happy path needs real docker and is covered by the Step 7 smoke, not here —
per the spec's §8, do not invent a mock layer to make it unit-testable.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test lifecycle-remove.test.mjs`
Expected: FAIL — `removeService` is not exported.

- [ ] **Step 4: Implement in `lifecycle.ts`**

Move the body of `apps/cli/src/commands/remove.ts:26-77` verbatim, replacing the
two `process.exit`/`return` paths with the two `SandboxError` throws above. Keep
every `info()` call and its exact wording — those are CLI output. The
`composeDown` return value is already checked at `remove.ts:72`; preserve that
`warn`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test lifecycle-remove.test.mjs`
Expected: PASS.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/remove.ts` keeps its banner, its two `SandboxError`
catches, and the summary block at lines 79-93 rendered from `RemoveResult`.

- [ ] **Step 7: Diff the output and smoke the real path**

```bash
./sandbox up demo -s backend,frontend
./sandbox remove demo backend > /tmp/remove.after 2>&1
diff /tmp/remove.before /tmp/remove.after && echo IDENTICAL
./sandbox status   # backend should now show as k8s, not local
```

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/lifecycle.ts packages/sandbox-core/lifecycle-remove.test.mjs apps/cli/src/commands/remove.ts
git commit -m "refactor(core): move the remove sequence into lifecycle"
```

---

### Task 3: `proxy-reload`

`lifecycle.reloadProxy()` already exists but lacks the `startCaddy` fallback that
`apps/cli/src/commands/proxy_reload.ts` has — a genuine behavioural gap between
the two spellings, not just a missing wrapper.

**Files:**
- Modify: `packages/sandbox-core/lifecycle.ts` (`reloadProxy` at line 404)
- Modify: `apps/cli/src/commands/proxy_reload.ts` (65 → ~30)
- Test: `packages/sandbox-core/lifecycle-proxy.test.mjs` (create)

**Interfaces:**
- Consumes: `generateCaddyfile` (`./generate.js`), `isCaddyRunning`, `reloadCaddy`,
  `startCaddy` (`./caddy.js`), `getAllSlots` (`./slots.js`).
- Produces:
```typescript
export interface ProxyReloadResult {
  features: Array<{ feature: string; slot: number | string; services: string[] }>;
  started: boolean;   // Caddy was down and was started
  ok: boolean;
}
export async function reloadProxy(opts?: { start?: boolean }): Promise<ProxyReloadResult>;
```
`start` defaults to `false`, preserving today's `reloadProxy()` behaviour for its
three existing callers (`commands/down.ts:142,162`, `sandbox.ts:2012,2272`). The
`proxy-reload` command passes `{ start: true }`.

- [ ] **Step 1: Capture current output**

```bash
./sandbox proxy-reload > /tmp/proxy.before 2>&1; cat /tmp/proxy.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/lifecycle-proxy.test.mjs`:

```javascript
// reloadProxy has two callers with different needs: down wants a reload only,
// proxy-reload wants Caddy started if it is down. The default must stay
// "reload only" or every teardown starts a proxy it did not ask for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reloadProxy } from "./dist/lifecycle.js";

test("reloadProxy reports the active features it wrote into the Caddyfile", async () => {
  const result = await reloadProxy();
  assert.ok(Array.isArray(result.features));
  assert.equal(typeof result.ok, "boolean");
  for (const f of result.features) {
    assert.equal(typeof f.feature, "string");
    assert.ok(Array.isArray(f.services));
  }
});

test("reloadProxy does not start Caddy unless asked", async () => {
  const result = await reloadProxy();
  assert.equal(result.started, false);
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test lifecycle-proxy.test.mjs`
Expected: FAIL — `reloadProxy` returns `void` today, so `result.features` is a
`TypeError` on undefined.

- [ ] **Step 4: Widen `reloadProxy`**

Add the `opts.start` branch and the return value. Keep the existing
`info("Updating reverse proxy configuration...")` and
`info("Caddy is not running -- skipping reload")` wording for the `start: false`
path — three callers print those today.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test lifecycle-proxy.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/proxy_reload.ts` calls `reloadProxy({ start: true })` and
renders the banner, the "Features in Caddyfile" list from `result.features`, and
the success/error line from `result.ok`. Its `warn("Caddy is not running -- starting it...")`
moves into the library alongside the `startCaddy` call, since it is progress, not layout.

- [ ] **Step 7: Diff the output**

```bash
./sandbox proxy-reload > /tmp/proxy.after 2>&1
diff /tmp/proxy.before /tmp/proxy.after && echo IDENTICAL
curl -sS -o /dev/null -w '%{http_code}\n' https://tools.local.sandbox.com/jaeger
```

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/lifecycle.ts packages/sandbox-core/lifecycle-proxy.test.mjs apps/cli/src/commands/proxy_reload.ts
git commit -m "refactor(core): reloadProxy returns its features and can start Caddy"
```

---

### Task 4: `clean`

**Files:**
- Modify: `packages/sandbox-core/lifecycle.ts`
- Modify: `apps/cli/src/commands/clean.ts` (232 → ~70)
- Test: `packages/sandbox-core/lifecycle-clean.test.mjs` (create)

**Interfaces:**
- Consumes: `listVolumeNames`, `removeVolume` (`./docker.js`), `getAllSlots`,
  `releaseSlot` (`./slots.js`), `composeDown`, `getContainerStatus`,
  `workspaceForFeature` (`./compose.js`), `generateCaddyfile` (`./generate.js`),
  `getVolumeBaseNames` (`./config.js`).
- Produces:
```typescript
export interface CleanPlan {
  orphanedVolumes: string[];
  staleSlots: string[];       // feature names holding a slot with no containers
}
export interface CleanResult extends CleanPlan { removedVolumes: string[]; releasedSlots: string[]; }
export async function planClean(opts?: { all?: boolean }): Promise<CleanPlan>;
export async function runClean(opts?: { all?: boolean; dryRun?: boolean }): Promise<CleanResult>;
```
The split exists because `--dry-run` is a real flag: `planClean` is what it needs,
and `runClean` calls it. Also export the two pure helpers now private in the
command — `featureFromVolume(volName: string, baseNames: string[]): string | null`
(`clean.ts:73`) and `volumeBaseNames(): string[]` (`clean.ts:25`).

- [ ] **Step 1: Capture current output**

```bash
./sandbox clean --dry-run > /tmp/clean.before 2>&1; cat /tmp/clean.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/lifecycle-clean.test.mjs`:

```javascript
// featureFromVolume is the parser that decides what gets deleted. It is the one
// part of clean worth a unit test: a wrong answer removes someone's node_modules.
import { test } from "node:test";
import assert from "node:assert/strict";

import { featureFromVolume, planClean } from "./dist/lifecycle.js";

test("featureFromVolume extracts the feature from a per-feature volume name", () => {
  assert.equal(featureFromVolume("sandbox-demo-node_modules", ["node_modules"]), "demo");
});

test("featureFromVolume ignores a volume whose base name is not ours", () => {
  assert.equal(featureFromVolume("some-other-project-cache", ["node_modules"]), null);
});

test("planClean never proposes removing a volume for a feature holding a slot", async () => {
  const plan = await planClean();
  const { getAllSlots } = await import("./dist/slots.js");
  const live = Object.keys(await getAllSlots());
  for (const vol of plan.orphanedVolumes) {
    const feature = featureFromVolume(vol, ["node_modules"]);
    if (feature) assert.ok(!live.includes(feature), `would delete live feature ${feature}`);
  }
});
```

Read `clean.ts:73-82` for the real naming scheme before writing the first two
assertions — if the prefix is not `sandbox-<feature>-<base>`, correct the fixtures
to match the code, not the code to match the fixtures.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test lifecycle-clean.test.mjs`
Expected: FAIL — neither export exists.

- [ ] **Step 4: Implement in `lifecycle.ts`**

Move `volumeBaseNames`, `listSandboxVolumes`, `featureFromVolume` and the sweep
body of `run` (`clean.ts:84-232`) across. Every `info`/`success`/`warn` keeps its
wording. The `composeDown` failure `warn` at `clean.ts:119` stays.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test lifecycle-clean.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/clean.ts` maps `--all`/`--dry-run` to the options object
and renders the plan or the result. The dry-run branch calls `planClean`.

- [ ] **Step 7: Diff the output**

```bash
./sandbox clean --dry-run > /tmp/clean.after 2>&1
diff /tmp/clean.before /tmp/clean.after && echo IDENTICAL
```
Run the dry-run form on both sides. Do **not** diff a real `./sandbox clean` — it
is destructive and not idempotent.

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/lifecycle.ts packages/sandbox-core/lifecycle-clean.test.mjs apps/cli/src/commands/clean.ts
git commit -m "refactor(core): move the clean sweep into lifecycle"
```

---

### Task 5: `detect`

**Files:**
- Modify: `packages/sandbox-core/detect.ts`
- Modify: `apps/cli/src/commands/detect.ts` (76 → ~45)
- Test: `packages/sandbox-core/detect-report.test.mjs` (create)

**Interfaces:**
- Consumes: `detectChangedServices` (already in `detect.ts`), `resolveWorkspace`,
  `loadServices` (`./config.js`).
- Produces:
```typescript
export interface DetectReport {
  workspace: string;
  workspaceExists: boolean;
  serviceCount: number;                                    // registry size
  detected: Array<{ service: string; repo: string; type: string }>;
  nonLocal: string[];                                      // sorted
}
export function detectReport(feature: string, workspaceOverride?: string | null): DetectReport;
```
Returns rather than throwing for the two warning paths — a missing workspace and
an empty registry are both reported through the fields, because the command
prints a different hint for each and neither is an error exit today.

- [ ] **Step 1: Capture current output**

```bash
./sandbox detect demo > /tmp/detect.before 2>&1; cat /tmp/detect.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/detect-report.test.mjs`:

```javascript
// The report exists so the command holds only printResults. Its two "nothing to
// do" paths are fields rather than throws, because each prints a different hint.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectReport } from "./dist/detect.js";

test("a missing workspace is reported, not thrown", () => {
  const r = detectReport("ghost", "/definitely/not/a/workspace");
  assert.equal(r.workspaceExists, false);
  assert.deepEqual(r.detected, []);
});

test("detected and nonLocal partition the registry", () => {
  const r = detectReport("");
  if (!r.workspaceExists || r.serviceCount === 0) return; // nothing to assert here
  const names = new Set(r.detected.map((d) => d.service));
  for (const n of r.nonLocal) assert.ok(!names.has(n));
  assert.equal(names.size + r.nonLocal.length, r.serviceCount);
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test detect-report.test.mjs`
Expected: FAIL — `detectReport` is not exported.

- [ ] **Step 4: Implement in `detect.ts`**

`detectReport` does the `resolveWorkspace` call, the `fs.existsSync` check, the
`loadServices` read, and the `detectChangedServices` call, then joins each
detected name to its `repo` and `type` — the lookup now at
`apps/cli/src/commands/detect.ts:21-25`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test detect-report.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Reduce the command**

`printResults` stays exactly as it is, fed from `report.detected` and
`report.nonLocal`. The two warning branches read `workspaceExists` and
`serviceCount`. The `info(`Workspace: …`)` and `info(`Service registry: …`)` lines
move into the library — they are progress.

- [ ] **Step 7: Diff the output**

```bash
./sandbox detect demo > /tmp/detect.after 2>&1
diff /tmp/detect.before /tmp/detect.after && echo IDENTICAL
```

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/detect.ts packages/sandbox-core/detect-report.test.mjs apps/cli/src/commands/detect.ts
git commit -m "refactor(core): detect returns a report instead of printing one"
```

---

### Task 6: `standards`

**Files:**
- Modify: `packages/sandbox-core/standards.ts`
- Modify: `apps/cli/src/commands/standards.ts` (54 → ~25)
- Test: `packages/sandbox-core/standards-check.test.mjs` (create)

**Interfaces:**
- Consumes: `standardsDirPath`, `standardsDirProblem` (`./global_config.js`),
  `validateModuleReferences` (`./skill_gen.js`), `loadStandardsModules`,
  `validateStandardModules`, `validateServiceStandards` (already in `standards.ts`),
  `loadServices` (`./config.js`).
- Produces:
```typescript
export interface StandardsCheck {
  dir: string;
  moduleCount: number;
  errors: string[];   // empty means well-formed
}
export function checkStandards(): StandardsCheck;
```
Never throws and never exits. A missing tree and an empty tree each produce a
one-element `errors` array carrying today's exact message, so the gate still fails
loudly — the point of `standardsDirProblem` existing at all.

- [ ] **Step 1: Capture current output**

```bash
./sandbox standards check > /tmp/standards.before 2>&1; echo "exit=$?"; cat /tmp/standards.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/standards-check.test.mjs`:

```javascript
// The gate's whole value is failing when there is nothing to check. A missing or
// empty tree reporting "0 modules checked" and exiting 0 is the bug this guards.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkStandards } from "./dist/standards.js";

test("checkStandards returns errors as data and never exits", () => {
  const result = checkStandards();
  assert.equal(typeof result.dir, "string");
  assert.equal(typeof result.moduleCount, "number");
  assert.ok(Array.isArray(result.errors));
});

test("a well-formed tree reports no errors and a non-zero module count", () => {
  const result = checkStandards();
  if (result.errors.length) {
    assert.fail(`this repo's standards tree should be clean: ${result.errors.join("; ")}`);
  }
  assert.ok(result.moduleCount > 0, "an empty tree must not read as success");
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test standards-check.test.mjs`
Expected: FAIL — `checkStandards` is not exported.

- [ ] **Step 4: Implement in `standards.ts`**

Move the body of `apps/cli/src/commands/standards.ts:24-53`, turning each of the
three `process.exit(1)` paths into an `errors` entry with the same message text.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test standards-check.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Reduce the command**

The command calls `checkStandards()`, prints `error(…)` and the indented
`info("  - " + e)` lines for each error then `process.exit(1)`, or the existing
`success(...)` line. The exit stays in the command — that is exit-code mapping.

- [ ] **Step 7: Diff the output, both ways**

```bash
./sandbox standards check > /tmp/standards.after 2>&1; echo "exit=$?"
diff /tmp/standards.before /tmp/standards.after && echo IDENTICAL
```
Then force the failure path and confirm it still exits 1:
```bash
SANDBOX_STANDARDS_DIR=/tmp/empty-tree ./sandbox standards check; echo "exit=$? (expect 1)"
```
Check `global_config.ts` for the real env var name before running this; if there
is none, temporarily rename the standards directory instead.

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test && ./sandbox standards check
git add packages/sandbox-core/standards.ts packages/sandbox-core/standards-check.test.mjs apps/cli/src/commands/standards.ts
git commit -m "refactor(core): checkStandards returns errors instead of exiting"
```

---

### Task 7: `skills`

**Files:**
- Modify: `packages/sandbox-core/workspace_skills.ts`
- Modify: `apps/cli/src/commands/skills.ts` (146 → ~45)
- Test: `packages/sandbox-core/workspace-skills-manifest.test.mjs` (create)

**Interfaces:**
- Consumes: `checkWorkspaceSkills`, `writeWorkspaceSkills` (already here);
  `loadStandardsModules`, `repoDirs`, `resolveActiveStandards`,
  `buildStandardsManifest`, `writeStandardsManifest` (`./standards.js`);
  `loadConfigFile`, `loadSandboxServiceConfigs` (`./workspace_prompts.js`);
  `validateModuleReferences` (`./skill_gen.js`).
- Produces:
```typescript
export function canonical(value: unknown): unknown;
export function resolveWorkspaceManifest(workspace: string): Record<string, any> | null;
export interface SkillsCheck { authoring: string[]; drift: string[]; }
export function checkSkills(workspace: string): SkillsCheck;
export interface SkillsSync { written: string[]; manifestPath: string | null; }
export function syncSkills(workspace: string): SkillsSync;
```
`checkSkills` folds the `.sandbox/standards.json` staleness comparison into
`drift`, appending the literal `"stale: .sandbox/standards.json"` entry the command
appends today.

- [ ] **Step 1: Capture current output**

```bash
cd ~/workspace 2>/dev/null || cd "$(git rev-parse --show-toplevel)"
sandbox skills check > /tmp/skills.before 2>&1; echo "exit=$?"; cat /tmp/skills.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/workspace-skills-manifest.test.mjs`:

```javascript
// canonical() decides whether the manifest is stale. Order-independence is the
// whole point: a re-serialised manifest with reordered keys is not drift.
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonical } from "./dist/workspace_skills.js";

test("canonical sorts object keys at every depth", () => {
  const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
  const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
  assert.equal(JSON.stringify(canonical(a)), JSON.stringify(canonical(b)));
});

test("canonical preserves array order, which is meaningful", () => {
  assert.notEqual(
    JSON.stringify(canonical({ x: [1, 2] })),
    JSON.stringify(canonical({ x: [2, 1] })),
  );
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test workspace-skills-manifest.test.mjs`
Expected: FAIL — `canonical` is not exported.

- [ ] **Step 4: Implement in `workspace_skills.ts`**

Move `canonical` (`skills.ts:34-47`) and `resolveWorkspaceManifest`
(`skills.ts:58-80`) across verbatim, then add `checkSkills` and `syncSkills`
wrapping what `run` does today. The `info(`wrote ${p}`)` calls move with
`syncSkills`; the red `✗` lines stay in the command, because the `Colors.RED`
formatting is rendering.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test workspace-skills-manifest.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/skills.ts` resolves the workspace with `findWorkspaceRoot`
(imported from `sandbox-core/gate` after Plan 1 Task 1), branches on
`args.action`, and renders. It keeps its `process.exit(1)` when
`authoring.length || drift.length`.

- [ ] **Step 7: Diff the output**

```bash
sandbox skills check > /tmp/skills.after 2>&1; echo "exit=$?"
diff /tmp/skills.before /tmp/skills.after && echo IDENTICAL
```

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test && ./sandbox standards check
git add packages/sandbox-core/workspace_skills.ts packages/sandbox-core/workspace-skills-manifest.test.mjs apps/cli/src/commands/skills.ts
git commit -m "refactor(core): move the skills drift check into workspace_skills"
```

---

### Task 8: `logs`

**Files:**
- Modify: `packages/sandbox-core/compose.ts` (`composeLogs` at line 287)
- Modify: `apps/cli/src/commands/logs.ts` (29 → ~20)
- Test: none new — `composeLogsStream` is already covered by
  `packages/sandbox-core/compose-logs.smoke.mjs`

**Interfaces:**
- Consumes: `getSlot` (`./slots.js`), `interruptSignal()` (Plan 1 Task 4).
- Produces: `composeLogs(feature: string, service?: string | null, signal?: AbortSignal): void`
  — a third optional parameter on the existing export, so no caller changes.

- [ ] **Step 1: Capture current output**

```bash
timeout 5 ./sandbox logs demo > /tmp/logs.before 2>&1; head -5 /tmp/logs.before
```

- [ ] **Step 2: Add the slot guard to the library**

Move the `getSlot` check from `apps/cli/src/commands/logs.ts:19-24` into
`composeLogs`, emitting the same two `warn` lines and returning early. This is the
verb's only logic.

- [ ] **Step 3: Accept the signal**

Add the `signal` parameter and pass it through to the underlying spawn. Note
`composeLogs` currently goes through `proc.run` (`spawnSync`), which cannot be
aborted — so honouring the signal means routing it through `runAsync` from Plan 1
Task 2, or documenting in a comment that the parameter is accepted and ignored on
the sync path. **Prefer routing it through `runAsync`**; a silently-ignored signal
is worse than no parameter.

- [ ] **Step 4: Reduce the command**

`apps/cli/src/commands/logs.ts` keeps its banner and calls
`composeLogs(feature, service, interruptSignal())`.

- [ ] **Step 5: Verify the tail still streams and Ctrl-C still stops it**

```bash
./sandbox up demo
./sandbox logs demo    # Ctrl-C after a few lines
ps aux | grep 'docker compose'   # expect nothing left behind
```

- [ ] **Step 6: Diff and commit**

```bash
timeout 5 ./sandbox logs demo > /tmp/logs.after 2>&1
diff <(head -5 /tmp/logs.before) <(head -5 /tmp/logs.after) && echo IDENTICAL
npx turbo run typecheck build test
git add packages/sandbox-core/compose.ts apps/cli/src/commands/logs.ts
git commit -m "refactor(core): composeLogs owns the slot guard and takes a signal"
```

---

### Task 9: `stats`

**Files:**
- Modify: `packages/sandbox-core/stats.ts`
- Modify: `apps/cli/src/commands/stats.ts` (280 → ~130, the two table renderers)
- Test: `packages/sandbox-core/stats-collect.test.mjs` (create)

**Interfaces:**
- Consumes: `containerStats` (`./docker.js`), `collectStats`, `formatMem`,
  `halveCpu`, `recommendLimits` (already in `stats.ts`).
- Produces:
```typescript
export interface CollectionRun { samples: number; durationMinutes: number; saved: boolean; }
export async function runCollection(
  durationMinutes: number,
  intervalSeconds: number,
  save: boolean,
  signal?: AbortSignal,
): Promise<CollectionRun>;
```
The interruptible sleep loop now at `apps/cli/src/commands/stats.ts:240-275`
(`collectInterruptible`, `sleep`) moves with it, driven by `signal` instead of by
a CLI-local SIGINT listener.

- [ ] **Step 1: Capture current output**

```bash
./sandbox stats > /tmp/stats.before 2>&1; cat /tmp/stats.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/stats-collect.test.mjs`:

```javascript
// The collection loop is the only part of stats with control flow. An aborted
// run must return the samples it already has, not throw them away.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runCollection } from "./dist/stats.js";

test("runCollection stops early when the signal fires and keeps its samples", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const run = await runCollection(60, 1, false, ac.signal);
  assert.ok(run.samples >= 0);
  assert.ok(run.durationMinutes < 60, "an aborted run must report what it actually did");
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test stats-collect.test.mjs`
Expected: FAIL — `runCollection` is not exported from `stats.ts`.

- [ ] **Step 4: Implement in `stats.ts`**

Move `runCollection`, `collectInterruptible` and `sleep`. Replace the SIGINT
handling inside `collectInterruptible` with `signal.addEventListener("abort", …)`;
the command no longer installs its own listener.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test stats-collect.test.mjs`
Expected: PASS.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/stats.ts` keeps `formatStatsTable`, `formatRecommendations`
and `fmtMem` — all rendering — plus `runSnapshot`'s printing. It passes
`interruptSignal()` into `runCollection`.

- [ ] **Step 7: Diff the output**

```bash
./sandbox stats > /tmp/stats.after 2>&1
diff /tmp/stats.before /tmp/stats.after && echo IDENTICAL
```
The numbers move between runs; diff the *shape* — if only digits differ, that is
expected. Any change in column widths, headers or ordering is a regression.

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/stats.ts packages/sandbox-core/stats-collect.test.mjs apps/cli/src/commands/stats.ts
git commit -m "refactor(core): move the stats collection loop into stats"
```

---

### Task 10: `optimize`

**Files:**
- Modify: `packages/sandbox-core/stats.ts`
- Modify: `apps/cli/src/commands/optimize.ts` (216 → ~80)
- Test: `packages/sandbox-core/stats-optimize.test.mjs` (create)

**Interfaces:**
- Consumes: `collectStats`, `formatMem`, `recommendLimits` (already in `stats.ts`),
  `loadServices` (`./config.js`).
- Produces:
```typescript
export function parseConfigMem(memStr: string): number;   // → MiB
export function matchService(containerName: string, configured: Record<string, any>): string | null;
export interface OptimizeReport {
  recommendations: Array<{ service: string; current: string; recommended: string; reason: string }>;
  unmatched: string[];
}
export async function optimizeReport(collectMinutes?: number): Promise<OptimizeReport>;
```
Read `optimize.ts:159-177` and `:178-216` for the real shapes of the two helpers
and of a recommendation before finalising the field names — match what is there
rather than these placeholders if they differ.

- [ ] **Step 1: Capture current output**

```bash
./sandbox optimize > /tmp/optimize.before 2>&1; cat /tmp/optimize.before
```

- [ ] **Step 2: Write the failing test**

Create `packages/sandbox-core/stats-optimize.test.mjs`:

```javascript
// parseConfigMem reads the memory strings out of compose config. Getting a unit
// wrong by 1024x silently produces absurd recommendations, so pin the units.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConfigMem, matchService } from "./dist/stats.js";

test("parseConfigMem normalises every unit it accepts to MiB", () => {
  assert.equal(parseConfigMem("512m"), 512);
  assert.equal(parseConfigMem("2g"), 2048);
});

test("matchService finds the configured service inside a compose container name", () => {
  assert.equal(matchService("sandbox-demo-backend-1", { backend: {}, frontend: {} }), "backend");
  assert.equal(matchService("sandbox-demo-unknown-1", { backend: {} }), null);
});
```

Read `optimize.ts:159` first for the exact units accepted — if it handles `M`/`G`
or bytes, extend these assertions to cover what the code actually does.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/sandbox-core && npx tsc && node --test stats-optimize.test.mjs`
Expected: FAIL — neither helper is exported from `stats.ts`.

- [ ] **Step 4: Implement in `stats.ts`**

Move both helpers and the analysis body of `run` (`optimize.ts:16-158`), keeping
its `info`/`warn` wording.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test stats-optimize.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Reduce the command**

`apps/cli/src/commands/optimize.ts` renders `report.recommendations` and
`report.unmatched`.

- [ ] **Step 7: Diff the output**

```bash
./sandbox optimize > /tmp/optimize.after 2>&1
diff /tmp/optimize.before /tmp/optimize.after && echo IDENTICAL
```

- [ ] **Step 8: Verify and commit**

```bash
npx turbo run typecheck build test
git add packages/sandbox-core/stats.ts packages/sandbox-core/stats-optimize.test.mjs apps/cli/src/commands/optimize.ts
git commit -m "refactor(core): move the optimize analysis into stats"
```

---

## Done when

- All ten commands contain only argv mapping, rendering, exit-code mapping and
  cwd resolution.
- `grep -rn "process.exit" apps/cli/src/commands/{services,remove,proxy_reload,clean,detect,standards,skills,logs,stats,optimize}.ts`
  shows only exits in a `SandboxError` catch or an explicit gate-failure branch.
- Every captured `.before`/`.after` pair diffs clean.
- `npx turbo run typecheck build test` and `./sandbox standards check` pass.

**Next:** Plan 3 (`…-3-tier-2.md`) — the seven verbs that need judgment.
