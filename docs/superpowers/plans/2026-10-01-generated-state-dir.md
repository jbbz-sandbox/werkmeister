# Generated State Dir Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every file `sandbox connect` generates lands under `~/.sandbox/infra/` instead of inside the CLI package, so a global npm install works on a root-owned prefix and an upgrade never deletes a mounted file.

**Architecture:** One new path function, `stateInfraRoot()`, sits beside `infraRoot()` in `sandbox-core/config.ts`. The five writers switch to it. The two `GENERATED` regions that mutated the shipped `shared-infra.yml` become a generated compose override file, and a single `composeInvocation()` helper in a new `sandbox-core/compose_infra.ts` gives every `docker compose` call both `-f` files and the `SANDBOX_STATE_DIR` env var the shipped compose file interpolates. Skills and docs follow the path.

**Tech Stack:** TypeScript (ESM, `tsc` for sandbox-core, esbuild bundle for the CLI), `node --test` for sandbox-core tests (`*.test.mjs` run against `dist/`), vitest for `apps/cli` tests, Docker Compose v2 file interpolation.

**Spec:** `docs/superpowers/specs/2026-10-01-generated-state-dir-design.md`

## Global Constraints

- Node `>=20`; sandbox-core is ESM with `.js` import specifiers for `.ts` siblings.
- sandbox-core tests import from `./dist/*.js`, so run `npx tsc` in `packages/sandbox-core` before `node --test`. `npm test` there does this (`tsc && node --test *.test.mjs && smokes`).
- CLI tests: `cd apps/cli && npx vitest run <file>`. The CLI `test` script runs `node esbuild.mjs` first.
- Never write into the developer's real `~/.sandbox` from a test: set `SANDBOX_CONFIG_FILE` to a temp path (sandbox-core tests) or use `useSandboxHome()` (CLI tests, `apps/cli/src/lib/__tests__/helpers/sandbox_home.ts`).
- The state dir layout is fixed by the spec D1: `~/.sandbox/infra/proxy/Caddyfile`, `~/.sandbox/infra/proxy/features.json`, `~/.sandbox/infra/k8s-port-forward/kubeconfig`, `~/.sandbox/infra/k8s-port-forward/forwards`, `~/.sandbox/infra/compose/k8s-forwards.override.yml`.
- The compose env var name is `SANDBOX_STATE_DIR`, value `stateInfraRoot()`.
- Shipped `infra/` files are read via `infraRoot()` and never written. Done check (spec §5): `grep -rn "proxy/Caddyfile\|k8s-port-forward/tmp\|proxy/ui/features" packages/sandbox-core/*.ts apps/cli/src` must return no hit that builds a path from `infraRoot()`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Spec deviation, recorded here: the spec put `composeInvocation()` in `infra.ts`. `infra.ts` imports `k8s.ts`, and `k8s.ts`, `caddy.ts` and `status.ts` would all need to import the helper, which makes an import cycle `infra → k8s → infra`. The helper therefore lives in a new leaf module `compose_infra.ts` that imports only `config.ts` and `k8s_forwards.ts`.

## Review Focus

1. **A fresh machine runs `sandbox status` or `sandbox down` before any `connect`.** The override file does not exist yet, and `docker compose -f <missing>` hard-errors. Expected: the command works. Pinned in Task 3 (`composeInvocation()` creates the override when absent).
2. **A registry with no forwards at all.** The override must still be a valid compose file. Expected: `services:\n  k8s-forwards: {}\n`. Pinned in Task 2.
3. **Docker created a directory where the Caddyfile should be** (it does this for a missing bind source). Expected: the next `generateCaddyfile()` replaces the directory with a file. Pinned in Task 4.
4. **`SANDBOX_CONFIG_FILE` is relative.** `path.dirname` of a relative path is relative, and Compose resolves a relative `${SANDBOX_STATE_DIR}` against the compose file's directory, which is the package. Expected: `stateInfraRoot()` is always absolute. Pinned in Task 1.
5. **A checkout that predates this change still has the old generated files under `apps/cli/infra/`.** Expected: nothing reads or deletes them, `.gitignore` keeps ignoring them, and `git status` stays clean after `connect`. Pinned in Task 6 (the tracked `tmp/` files are untracked and the directory gitignored) and by the Task 7 manual check that `ls -R <package>/infra` is unchanged across a generation run.

---

### Task 1: `stateInfraRoot()` in `sandbox-core/config.ts`

**Files:**
- Modify: `packages/sandbox-core/config.ts:566-574`
- Test: `packages/sandbox-core/config.test.mjs`

**Interfaces:**
- Consumes: `sandboxHome()` (`config.ts:54`), which derives `~/.sandbox` from `configPath()` and therefore honours `SANDBOX_CONFIG_FILE`.
- Produces: `export function stateInfraRoot(): string` returning an absolute path `<sandboxHome>/infra`. Every later task builds generated-file paths from it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-core/config.test.mjs`, inside the existing file after the last `test(...)` block (the file already imports `sandboxHome` and manages `SANDBOX_CONFIG_FILE` in `beforeEach`/`afterEach`). Add `stateInfraRoot` to the import list from `./dist/config.js`:

```js
test("stateInfraRoot is <sandboxHome>/infra and follows SANDBOX_CONFIG_FILE", async () => {
  const dir = await withConfig("version: 1\n");
  assert.equal(stateInfraRoot(), path.join(dir, "infra"));
  assert.equal(stateInfraRoot(), path.join(sandboxHome(), "infra"));
});

test("stateInfraRoot is absolute even when SANDBOX_CONFIG_FILE is relative", () => {
  process.env.SANDBOX_CONFIG_FILE = "rel/config.yaml";
  assert.ok(path.isAbsolute(stateInfraRoot()), stateInfraRoot());
  assert.equal(stateInfraRoot(), path.resolve("rel", "infra"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && node --test config.test.mjs`
Expected: FAIL with `stateInfraRoot is not a function` (or an import error naming it).

- [ ] **Step 3: Implement**

In `packages/sandbox-core/config.ts`, replace the `infraRoot` docblock and add the new function directly after it:

```ts
/**
 * The `infra/` dir holding compose files, templates, the proxy UI, schemas and
 * skills. All versioned code — the machine-specific registry files live in
 * `~/.sandbox` instead, reached via {@link servicesYamlPath} and friends, and
 * everything the CLI *generates* for the shared infra lives under
 * {@link stateInfraRoot}. Nothing writes here at runtime.
 */
export function infraRoot(): string {
  return path.join(sandboxRoot(), "infra");
}

/**
 * `~/.sandbox/infra`: the generated runtime files for the shared infra — the
 * Caddyfile, features.json, the pinned kubeconfig, the forwards table and the
 * k8s-forwards compose override. Read-only sibling: {@link infraRoot}.
 *
 * Derived from {@link sandboxHome} so `SANDBOX_CONFIG_FILE` relocates it with
 * the rest of `~/.sandbox`. Always absolute: Compose resolves a relative
 * `${SANDBOX_STATE_DIR}` against the compose file's directory, which is the
 * package — exactly where these files must not go.
 */
export function stateInfraRoot(): string {
  return path.resolve(sandboxHome(), "infra");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test config.test.mjs`
Expected: PASS, including the two new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-core/config.ts packages/sandbox-core/config.test.mjs
git commit -m "feat(core): stateInfraRoot() names ~/.sandbox/infra for generated runtime files

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Forwards table and compose override replace the in-place `shared-infra.yml` regions

**Files:**
- Modify: `packages/sandbox-core/k8s_forwards.ts` (whole file)
- Modify: `apps/cli/infra/compose/shared-infra.yml:24-63, 90-101, 168-180`
- Test: `apps/cli/src/lib/__tests__/k8s_forwards.test.ts`

**Interfaces:**
- Consumes: `stateInfraRoot()` from Task 1; `forwardSpecs()`/`ForwardSpec` (`{name, listen, remote, ns, prefix, health}`) already in this module.
- Produces:
  - `export function renderK8sForwardsOverride(specs: ForwardSpec[]): string` — pure, the override YAML.
  - `export function overrideFilePath(): string` — `<stateInfraRoot>/compose/k8s-forwards.override.yml`.
  - `export function generateK8sForwards(quiet = false): void` — same signature as today; now writes `<stateInfraRoot>/k8s-port-forward/forwards` and the override file.
  - `generateForwardsFile(dest?)` and `buildForwardRows()` unchanged.
  - Removed: `renderSharedInfraForwards`, `regenerateSharedInfraForwards`. Nothing outside this module imports them (`grep -rn` confirmed: only `infra.ts` imports `generateK8sForwards`; the CLI test imports `buildForwardRows`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/lib/__tests__/k8s_forwards.test.ts`. Extend the import to `import { buildForwardRows, renderK8sForwardsOverride } from "sandbox-core/k8s_forwards";` and add imports `import * as fs from "node:fs"; import * as path from "node:path"; import { fileURLToPath } from "node:url";`.

```ts
describe("renderK8sForwardsOverride", () => {
  const specs = [
    { name: "backend", listen: 9052, remote: 3000, ns: "default", prefix: "backend", health: "/health" },
    { name: "redis", listen: 9050, remote: 6379, ns: "default", prefix: "redis", health: "" },
  ];

  it("renders one published port and one network alias per forward", () => {
    expect(renderK8sForwardsOverride(specs)).toBe(
      [
        "# AUTO-GENERATED by `sandbox connect` from ~/.sandbox/services.yaml — do not edit.",
        "# Merged over infra/compose/shared-infra.yml by every `docker compose` call the CLI makes.",
        "services:",
        "  k8s-forwards:",
        "    ports:",
        '      - "9052:9052"   # backend',
        '      - "9050:9050"   # redis',
        "    networks:",
        "      shared-network:",
        "        aliases:",
        "          - k8s-backend",
        "          - k8s-redis",
        "",
      ].join("\n"),
    );
  });

  it("renders a valid empty service when there are no forwards", () => {
    expect(renderK8sForwardsOverride([])).toBe(
      [
        "# AUTO-GENERATED by `sandbox connect` from ~/.sandbox/services.yaml — do not edit.",
        "# Merged over infra/compose/shared-infra.yml by every `docker compose` call the CLI makes.",
        "services:",
        "  k8s-forwards: {}",
        "",
      ].join("\n"),
    );
  });
});

describe("shipped shared-infra.yml", () => {
  const composeFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../infra/compose/shared-infra.yml",
  );
  const text = fs.readFileSync(composeFile, "utf8");

  it("carries no GENERATED regions — the override file owns ports and aliases", () => {
    expect(text).not.toContain("GENERATED");
    expect(text).not.toMatch(/^\s+- "9\d{3}:9\d{3}"/m);
    expect(text).not.toMatch(/^\s+- k8s-(backend|frontend|redis|postgres)$/m);
  });

  it("mounts every generated file from ${SANDBOX_STATE_DIR}", () => {
    expect(text).toContain("${SANDBOX_STATE_DIR}/k8s-port-forward/kubeconfig:/tmp/kubeconfig:ro");
    expect(text).toContain("${SANDBOX_STATE_DIR}/k8s-port-forward/forwards:/tmp/forwards:ro");
    expect(text).toContain("${SANDBOX_STATE_DIR}/proxy/Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(text).toContain("${SANDBOX_STATE_DIR}/proxy/features.json:/sandbox/proxy/ui/features.json:ro");
    expect(text).not.toContain("./k8s-port-forward/tmp/");
    expect(text).not.toContain("../proxy/Caddyfile");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/cli && npx vitest run src/lib/__tests__/k8s_forwards.test.ts`
Expected: FAIL. `renderK8sForwardsOverride` is not exported, and the compose assertions fail on the current file.

- [ ] **Step 3: Rewrite `k8s_forwards.ts`**

Replace the whole file with:

```ts
/**
 * Generate the k8s port-forward table from services.yaml (the single source
 * of truth) into the two files that consume it at runtime, both under
 * `stateInfraRoot()` (`~/.sandbox/infra`):
 *
 * 1. `k8s-port-forward/forwards` — a pipe-delimited data file the container's
 *    entrypoint.sh reads to build its `FORWARDS` array.
 *
 * 2. `compose/k8s-forwards.override.yml` — the `k8s-forwards` service's
 *    published `ports:` and network `aliases:`, merged over the shipped
 *    `infra/compose/shared-infra.yml` by `composeInvocation()`. The shipped
 *    file itself is never written: it is part of the npm package.
 *
 * Both derive from the same `forwardSpecs()` list so they cannot drift. Both
 * are rewritten on every `sandbox connect`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  forwardSpecs as specsFrom,
  type ForwardSpec,
  loadInfrastructure,
  loadServices,
  stateInfraRoot,
} from "./config.js";
import { info } from "./reporter.js";

/**
 * The forward table, from the shared registry semantics in
 * `sandbox-core/config` — the dashboard's health checks read the same table,
 * so it is defined once. Loading the registry (and failing loud when it is
 * missing) stays here; the parse does not.
 */
export function forwardSpecs(
  services?: Record<string, any> | null,
  infrastructure?: Record<string, any> | null,
): ForwardSpec[] {
  return specsFrom(services ?? loadServices(), infrastructure ?? loadInfrastructure());
}

export type { ForwardSpec };

/** Pipe-delimited rows for the entrypoint's FORWARDS array. */
export function buildForwardRows(
  services?: Record<string, any> | null,
  infrastructure?: Record<string, any> | null,
): string[] {
  // Row format the entrypoint parses: name|listen|remote|namespace|pod_prefix|health
  return forwardSpecs(services, infrastructure).map(
    (s) => `${s.name}|${s.listen}|${s.remote}|${s.ns}|${s.prefix}|${s.health}`,
  );
}

function forwardsFilePath(): string {
  return path.join(stateInfraRoot(), "k8s-port-forward", "forwards");
}

/** The compose override `composeInvocation()` passes as its second `-f`. */
export function overrideFilePath(): string {
  return path.join(stateInfraRoot(), "compose", "k8s-forwards.override.yml");
}

/** Write the entrypoint's forward data file. Returns the path written. */
export function generateForwardsFile(dest?: string | null): string {
  dest = dest ?? forwardsFilePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const body = [
    "# AUTO-GENERATED by `sandbox connect` from ~/.sandbox/services.yaml — do not edit.",
    "# Format: name|listen_port|remote_port|namespace|pod_prefix|health_path",
    ...buildForwardRows(),
    "",
  ].join("\n");
  fs.writeFileSync(dest, body);
  return dest;
}

const _OVERRIDE_HEADER = [
  "# AUTO-GENERATED by `sandbox connect` from ~/.sandbox/services.yaml — do not edit.",
  "# Merged over infra/compose/shared-infra.yml by every `docker compose` call the CLI makes.",
];

/**
 * Pure: the k8s-forwards compose override for *specs*. Compose merges `ports`
 * and `aliases` lists by appending, so the shipped file must list none of
 * these — it doesn't, and the CLI test pins that. With no forwards the
 * service is an empty mapping, which Compose accepts.
 */
export function renderK8sForwardsOverride(specs: ForwardSpec[]): string {
  if (specs.length === 0) {
    return [..._OVERRIDE_HEADER, "services:", "  k8s-forwards: {}", ""].join("\n");
  }
  return [
    ..._OVERRIDE_HEADER,
    "services:",
    "  k8s-forwards:",
    "    ports:",
    ...specs.map((s) => `      - "${s.listen}:${s.listen}"   # ${s.name}`),
    "    networks:",
    "      shared-network:",
    "        aliases:",
    ...specs.map((s) => `          - k8s-${s.name}`),
    "",
  ].join("\n");
}

/**
 * Generate both consumers of the forward table. Called from `sandbox connect`
 * before `docker compose up`, and by `composeInvocation()` when the override
 * is missing (a fresh machine's first `status`/`down`).
 */
export function generateK8sForwards(quiet = false): void {
  generateForwardsFile();
  const override = overrideFilePath();
  fs.mkdirSync(path.dirname(override), { recursive: true });
  fs.writeFileSync(override, renderK8sForwardsOverride(forwardSpecs()));
  if (!quiet) {
    info(`Generated ${forwardsFilePath()} and ${override}`);
  }
}
```

- [ ] **Step 4: Edit `shared-infra.yml`**

Four edits in `apps/cli/infra/compose/shared-infra.yml`.

(a) The trust-boundary comment (`:24-34`), change the second bullet:

```yaml
  #   - ${SANDBOX_STATE_DIR}/k8s-port-forward/kubeconfig:/tmp/kubeconfig:ro  (read-only, generated)
```

(b) The `k8s-forwards` service: delete the whole `ports:` key with its markers and four entries (`:52-58`), and change the two generated mounts (`:61-63`) so the block reads:

```yaml
    container_name: sandbox-k8s-forwards
    restart: unless-stopped
    # Published ports and network aliases come from the generated override
    # (~/.sandbox/infra/compose/k8s-forwards.override.yml); see k8s_forwards.ts.
    volumes:
      - ${HOME}/.kube:/root/.kube:ro
      - ${SANDBOX_STATE_DIR}/k8s-port-forward/kubeconfig:/tmp/kubeconfig:ro
      # Forward table generated from services.yaml by `sandbox connect`.
      - ${SANDBOX_STATE_DIR}/k8s-port-forward/forwards:/tmp/forwards:ro
```

(c) The `k8s-forwards` network aliases (`:93-100`): keep only the service's own alias.

```yaml
    networks:
      shared-network:
        aliases:
          - k8s-forwards
```

(d) The `caddy` volumes (`:172-173`):

```yaml
    volumes:
      - ${SANDBOX_STATE_DIR}/proxy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ../proxy/ui:/sandbox/proxy/ui:ro
      # Generated beside the Caddyfile; a file bind over the shipped ui dir.
      - ${SANDBOX_STATE_DIR}/proxy/features.json:/sandbox/proxy/ui/features.json:ro
```

- [ ] **Step 5: Build core and run the tests**

Run: `cd packages/sandbox-core && npx tsc && cd ../../apps/cli && npx vitest run src/lib/__tests__/k8s_forwards.test.ts`
Expected: PASS, all describes.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/k8s_forwards.ts apps/cli/infra/compose/shared-infra.yml apps/cli/src/lib/__tests__/k8s_forwards.test.ts
git commit -m "feat(core): k8s-forwards ports/aliases move to a generated compose override under ~/.sandbox/infra

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `composeInvocation()` and the six compose call sites

**Files:**
- Create: `packages/sandbox-core/compose_infra.ts`
- Create: `packages/sandbox-core/compose-infra.test.mjs`
- Modify: `packages/sandbox-core/infra.ts:34-62, 213-229, 278-284`
- Modify: `packages/sandbox-core/caddy.ts:11, 32-34, 286-289, 413-415`
- Modify: `packages/sandbox-core/k8s.ts:11, 15, 27-29, 38, 93, 104`
- Modify: `packages/sandbox-core/status.ts:14-15, 42-49`

**Interfaces:**
- Consumes: `infraRoot()`, `stateInfraRoot()` (`config.ts`); `overrideFilePath()`, `generateK8sForwards()` (Task 2).
- Produces: `export function composeInvocation(): { argv: string[]; env: NodeJS.ProcessEnv }` where `argv` is `["docker", "compose", "-f", <shipped>, "-f", <override>]` and `env` is `process.env` plus `SANDBOX_STATE_DIR`. Call sites spread `argv` and pass `env` to `run`/`runAsync`.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-core/compose-infra.test.mjs`:

```js
// Every `docker compose` call the CLI makes goes through one helper, so the
// shipped file, the generated override and the env var the shipped file
// interpolates can never disagree. The override must exist before the first
// call on a fresh machine (`sandbox status` before any `connect`), so the
// helper creates it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { composeInvocation } from "./dist/compose_infra.js";
import { infraRoot, stateInfraRoot } from "./dist/config.js";

const VARS = ["SANDBOX_CONFIG_FILE", "SANDBOX_SERVICES_YAML", "SANDBOX_ROOT"];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

const REGISTRY = `
services: {}
infrastructure:
  redis:
    k8s_forward_port: 9050
    internal_port: 6379
    k8s_namespace: default
    k8s_pod_prefix: redis
    health_endpoint: ""
`;

let home;
beforeEach(async () => {
  VARS.forEach((v) => delete process.env[v]);
  home = await mkdtemp(path.join(tmpdir(), "sandbox-compose-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "config.yaml");
  await writeFile(path.join(home, "services.yaml"), REGISTRY);
  process.env.SANDBOX_SERVICES_YAML = path.join(home, "services.yaml");
  process.env.SANDBOX_ROOT = path.resolve(import.meta.dirname, "..", "..", "apps", "cli");
});
afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
});

test("argv names the shipped file then the override, env carries SANDBOX_STATE_DIR", () => {
  const { argv, env } = composeInvocation();
  assert.deepEqual(argv.slice(0, 2), ["docker", "compose"]);
  assert.deepEqual(argv.slice(2), [
    "-f", path.join(infraRoot(), "compose", "shared-infra.yml"),
    "-f", path.join(stateInfraRoot(), "compose", "k8s-forwards.override.yml"),
  ]);
  assert.equal(env.SANDBOX_STATE_DIR, path.join(home, "infra"));
  assert.equal(env.PATH, process.env.PATH, "inherits the process env");
});

test("creates the override from the registry when it is missing", () => {
  const override = path.join(home, "infra", "compose", "k8s-forwards.override.yml");
  assert.equal(existsSync(override), false);
  composeInvocation();
  assert.ok(existsSync(override));
  assert.match(readFileSync(override, "utf8"), /- "9050:9050"   # redis/);
});

test("leaves an existing override alone", async () => {
  const override = path.join(home, "infra", "compose", "k8s-forwards.override.yml");
  composeInvocation();
  await writeFile(override, "services: {}\n# sentinel\n");
  composeInvocation();
  assert.match(readFileSync(override, "utf8"), /sentinel/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sandbox-core && npx tsc && node --test compose-infra.test.mjs`
Expected: FAIL, `Cannot find module './dist/compose_infra.js'`.

- [ ] **Step 3: Create `compose_infra.ts`**

```ts
/**
 * The one way to spell `docker compose` for the shared infra.
 *
 * Two files: the shipped `infra/compose/shared-infra.yml` (read-only, part of
 * the npm package) and the generated `k8s-forwards.override.yml` under
 * `stateInfraRoot()`. The shipped file interpolates `${SANDBOX_STATE_DIR}` for
 * every generated mount, so the env this returns must reach the spawn.
 *
 * A leaf module on purpose: `infra.ts`, `caddy.ts`, `k8s.ts` and `status.ts`
 * all call this, and `infra.ts` already imports `k8s.ts`, so putting it in
 * `infra.ts` would make a cycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { infraRoot, stateInfraRoot } from "./config.js";
import { generateK8sForwards, overrideFilePath } from "./k8s_forwards.js";

export function composeInvocation(): { argv: string[]; env: NodeJS.ProcessEnv } {
  const override = overrideFilePath();
  // A fresh machine's first `status`/`down` arrives before any `connect` has
  // generated the override, and `-f <missing>` is a hard error. Pure text
  // from the registry, so generating it here is cheap and cannot loop.
  if (!fs.existsSync(override)) {
    generateK8sForwards(true);
  }
  return {
    argv: [
      "docker", "compose",
      "-f", path.join(infraRoot(), "compose", "shared-infra.yml"),
      "-f", override,
    ],
    env: { ...process.env, SANDBOX_STATE_DIR: stateInfraRoot() },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/sandbox-core && npx tsc && node --test compose-infra.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Switch `infra.ts`**

Add `import { composeInvocation } from "./compose_infra.js";` to the imports. Then:

Replace `composeCmd` (`:34-62`) body's first lines. Delete the `root`, `composeFile`, `envFile`, `envArgs` declarations and the comment about `--env-file`, so it begins:

```ts
function composeCmd(subcommand: string[]): boolean {
  const { argv, env } = composeInvocation();
  const cmd = [...argv, ...subcommand];
  info(`Running: ${cmd.join(" ")}`);
  try {
    const result = run(cmd, { capture: true, timeout: 120, env });
```

The rest of the function is unchanged.

Replace the top of `startSharedInfra` (`:213-229`):

```ts
async function startSharedInfra(signal?: AbortSignal): Promise<boolean> {
  const { argv, env } = composeInvocation();
  const composeFile = argv[3];

  if (!fs.existsSync(composeFile)) {
    warn(`Missing ${composeFile}`);
    return false;
  }

  info(
    "Starting shared infrastructure (k8s-forwards, caddy, jaeger, redisinsight)...",
  );
  try {
    const result = await runAsync(
      [...argv, "up", "-d", "--build"],
      { capture: true, signal, env },
    );
```

The rest is unchanged. (`argv[3]` is the shipped file: `["docker","compose","-f",<shipped>,...]`.)

Replace the top of `checkInfraHealth` (`:278-284`):

```ts
async function checkInfraHealth(): Promise<Record<string, boolean>> {
  const { argv, env } = composeInvocation();

  const services: Record<string, boolean> = {};
  try {
    const result = run(
      [...argv, "ps", "--format", "json"],
      { capture: true, env },
    );
```

If `infraRoot` or `sandboxRoot` is now unused in `infra.ts`, remove it from the `./config.js` import. (`ensureProxyFiles` still uses `infraRoot()` until Task 4 switches it; `sandboxRoot` was used only for the `.env` path and goes.)

- [ ] **Step 6: Switch `caddy.ts`**

Delete `_infraComposeFile` (`:32-34`). Add `import { composeInvocation } from "./compose_infra.js";`. In `_runCaddyCompose` (`:286-294`):

```ts
function _runCaddyCompose(args: string[], { capture = false }: { capture?: boolean } = {}): boolean {
  const { argv, env } = composeInvocation();
  const cmd = [...argv, ...args];
  info(`Running: ${cmd.join(" ")}`);

  let result;
  try {
    result = run(cmd, { capture, timeout: 60, env });
```

In `isCaddyRunning` (`:413-417`):

```ts
export function isCaddyRunning(): boolean {
  const { argv, env } = composeInvocation();
  const cmd = [...argv, "ps", "--status", "running", "-q", "caddy"];
  try {
    const result = run(cmd, { capture: true, timeout: 10, env });
```

The `--env-file ${sandboxRoot()}/.env` argument is gone: nothing creates that file, and passing a missing path is a Compose hard error. Keep `sandboxRoot` in the import only if `reloadCaddy` or another function still uses it (check with `grep -n sandboxRoot packages/sandbox-core/caddy.ts`).

- [ ] **Step 7: Switch `k8s.ts`**

Delete `infraComposeFile` (`:27-29`) and the `import * as path` and `infraRoot` imports if nothing else uses them. Add `import { composeInvocation } from "./compose_infra.js";`.

`checkPortForwardHealth` (`:37-47`):

```ts
export function checkPortForwardHealth(): Record<string, boolean> {
  const { argv, env } = composeInvocation();
  const results: Record<string, boolean> = {};

  try {
    const result = run(
      [...argv, "ps", "--format", "json", "k8s-forwards"],
      { capture: true, timeout: 10, env },
    );
```

`ensurePortForwardsHealthy` (`:93, 104-107`): replace `const composeFile = infraComposeFile();` with `const { argv, env } = composeInvocation();` and the `run` call with:

```ts
    const result = run(
      [...argv, "up", "-d", "--force-recreate", "k8s-forwards"],
      { capture: true, timeout: 60, env },
    );
```

- [ ] **Step 8: Switch `status.ts`**

`getInfraStatus` (`:41-49`):

```ts
export function getInfraStatus(): InfraContainer[] {
  const { argv, env } = composeInvocation();
  if (!fs.existsSync(argv[3])) {
    return [];
  }
  try {
    const result = procRun(
      [...argv, "ps", "--format", "json"],
      { capture: true, timeout: 10, env },
    );
```

Add `import { composeInvocation } from "./compose_infra.js";`. Remove `infraRoot` from the `./config.js` import if it is now unused there, and `path` if unused.

- [ ] **Step 9: Typecheck, grep, and run the core suite**

Run:
```bash
cd packages/sandbox-core && npx tsc --noEmit && \
grep -n "shared-infra.yml" infra.ts caddy.ts k8s.ts status.ts ; \
npm test 2>&1 | tail -20
```
Expected: `tsc` clean. The grep shows only `compose_infra.ts`-style references in comments, no `path.join(infraRoot(), "compose", "shared-infra.yml")` left in those four files. `npm test` passes (`infra-abort.test.mjs` and `forwards-wait.test.mjs` exercise these modules).

- [ ] **Step 10: Commit**

```bash
git add packages/sandbox-core/compose_infra.ts packages/sandbox-core/compose-infra.test.mjs packages/sandbox-core/infra.ts packages/sandbox-core/caddy.ts packages/sandbox-core/k8s.ts packages/sandbox-core/status.ts
git commit -m "refactor(core): one composeInvocation() for every docker compose call; adds the override and SANDBOX_STATE_DIR

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The Caddyfile, features.json and kubeconfig writers

**Files:**
- Modify: `packages/sandbox-core/generate.ts:1179-1204`
- Modify: `packages/sandbox-core/infra.ts:148-181`
- Modify: `packages/sandbox-core/caddy.ts:324`
- Modify: `packages/sandbox-core/claude_md.ts:522-527`
- Modify: `apps/cli/src/commands/proxy_reload.ts:26`
- Test: `apps/cli/src/lib/__tests__/generate.test.ts:19-26, 350-370`

**Interfaces:**
- Consumes: `stateInfraRoot()` (Task 1).
- Produces: `generateCaddyfile()` returns `<stateInfraRoot>/proxy/Caddyfile` and writes `<stateInfraRoot>/proxy/features.json`. `ensureProxyFiles()` writes the kubeconfig to `<stateInfraRoot>/k8s-port-forward/kubeconfig`.

- [ ] **Step 1: Update the generate test harness and write the failing tests**

In `apps/cli/src/lib/__tests__/generate.test.ts`:

Change the hoisted mock (`:19-26`) to redirect `stateInfraRoot` instead of `infraRoot`. `infraRoot` must keep resolving to the real shipped templates:

```ts
const h = vi.hoisted(() => ({ stateInfraRoot: null as string | null }));

vi.mock("sandbox-core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sandbox-core/config")>();
  // Redirects only what importers see: generate.ts writes the Caddyfile and
  // features.json under stateInfraRoot(), and that must land in tmp, never in
  // the developer's ~/.sandbox. infraRoot() stays real so the templates load.
  return { ...actual, stateInfraRoot: () => h.stateInfraRoot ?? actual.stateInfraRoot() };
});
```

Change the import on `:38` to `import { loadServices, stateInfraRoot } from "sandbox-core/config";`, and in `beforeEach` (`:50`) change `h.infraRoot = null;` to `h.stateInfraRoot = null;`.

In the `generateCaddyfile` describe (`:352-370`):

```ts
describe("generateCaddyfile", () => {
  beforeEach(() => {
    h.stateInfraRoot = tmp;
    // Fail here, not after writing: a redirect that silently fails writes a
    // Caddyfile full of fixture features into the developer's real ~/.sandbox.
    expect(stateInfraRoot()).toBe(tmp);
  });

  it("writes Caddyfile and features.json beside each other under proxy/", async () => {
    const outPath = await generateCaddyfile({ myfeat: { slot: 1, services: ["frontend"] } });
    expect(outPath).toBe(path.join(tmp, "proxy", "Caddyfile"));
    expect(fs.statSync(outPath).isFile()).toBe(true);

    const featuresJsonPath = path.join(tmp, "proxy", "features.json");
    expect(fs.statSync(featuresJsonPath).isFile()).toBe(true);
    expect(fs.existsSync(path.join(tmp, "proxy", "ui"))).toBe(false);
    const features = JSON.parse(fs.readFileSync(featuresJsonPath, "utf8"));
    expect(features).toEqual([{ name: "myfeat", slot: 1, services: ["frontend"] }]);
  });

  it("replaces a directory Docker left at the Caddyfile path", async () => {
    // Docker creates a directory for a missing bind-mount source. The next
    // generation must recover rather than fail on EISDIR.
    fs.mkdirSync(path.join(tmp, "proxy", "Caddyfile"), { recursive: true });
    const outPath = await generateCaddyfile({});
    expect(fs.statSync(outPath).isFile()).toBe(true);
  });
```

Leave the remaining `it(...)` blocks in that describe as they are. Also update the file's header comment (`:9-11`) to say "Caddyfile tests redirect stateInfraRoot into tmp so the real ~/.sandbox/infra/proxy/Caddyfile is never mutated".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/cli && npx vitest run src/lib/__tests__/generate.test.ts`
Expected: FAIL in the `generateCaddyfile` block: `outPath` is still under `infraRoot()` (the real `apps/cli/infra/proxy`), features.json is under `proxy/ui/`, and the directory case throws `EISDIR`. Confirm no file was written to `apps/cli/infra/proxy/Caddyfile` by the failing run; if one was, delete it (`git status` shows nothing since it is gitignored).

- [ ] **Step 3: Switch `generate.ts`**

Add `stateInfraRoot` to the `./config.js` import. Replace `:1179-1204`:

```ts
  const proxyDir = path.join(stateInfraRoot(), "proxy");
  fs.mkdirSync(proxyDir, { recursive: true });
  const outPath = path.join(proxyDir, "Caddyfile");
  // Docker creates a directory for a missing bind source; recover from one.
  if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
    fs.rmSync(outPath, { recursive: true, force: true });
  }

  // Acquire lock BEFORE reading slots / writing the Caddyfile.  Re-read
  // slots inside the lock so we always see the latest committed state.
  return sandboxLock("caddyfile", async () => {
    if (allFeatures === null || allFeatures === undefined) {
      allFeatures = await getAllSlots();
    }

    // Write features.json for the feature selector UI. Caddy serves it from
    // the shipped ui dir via a file bind-mount (shared-infra.yml), so it
    // lives beside the Caddyfile, not in a ui/ subdir.
    const featuresJson = Object.entries(allFeatures)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([, featInfo]) => isDict(featInfo))
      .map(([name, featInfo]) => ({
        name,
        slot: featInfo["slot"] ?? null,
        services: featInfo["services"] ?? [],
      }));
    fs.writeFileSync(
      path.join(proxyDir, "features.json"),
      JSON.stringify(featuresJson, null, 2) + "\n",
    );
```

If `infraRoot` is still imported in `generate.ts` for the templates (`infra/templates/*.njk`), keep it; otherwise drop it.

- [ ] **Step 4: Switch `infra.ts` `ensureProxyFiles`**

Delete the `// ponytail: these all write into the CLI's own directory ...` comment block (`:148-153`). Add `stateInfraRoot` to the `./config.js` import and replace the function's opening and kubeconfig path:

```ts
/** Generate proxy/Caddyfile and refresh the k8s kubeconfig, under ~/.sandbox/infra. */
async function ensureProxyFiles(): Promise<void> {
  const root = stateInfraRoot();

  // Always regenerate: the Caddyfile must carry the host routers (and any
  // active feature's routes) before Caddy loads it. generateCaddyfile() also
  // clears a directory Docker may have left at the path.
  info("Generating proxy/Caddyfile...");
  await generateCaddyfile();

  // Generate the k8s forward table from services.yaml into the file the
  // k8s-forwards container reads (k8s-port-forward/forwards) and the compose
  // override — must happen before `docker compose up`.
  generateK8sForwards();

  // Always regenerate from the host's current context so the k8s-forwards
  // container tracks `kubectl config use-context` instead of pinning to a
  // stale snapshot. --minify --flatten keeps the file self-contained.
  const kubeconfig = path.join(root, "k8s-port-forward", "kubeconfig");
  if (isDir(kubeconfig)) {
    fs.rmSync(kubeconfig, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(kubeconfig), { recursive: true });
  info("Refreshing k8s-port-forward/kubeconfig from current context...");
```

The `caddyfile` `isDir` block that preceded `generateCaddyfile()` is deleted (the guard moved into `generateCaddyfile`). Everything after `info("Refreshing ...")` is unchanged. Remove `infraRoot` from the import if nothing else in `infra.ts` uses it now.

- [ ] **Step 5: Switch `caddy.ts` `reloadCaddy`, `claude_md.ts`, `proxy_reload.ts`**

`caddy.ts:324`:
```ts
  const hostCaddyfile = `${stateInfraRoot()}/proxy/Caddyfile`;
```
Adjust the `./config.js` import: add `stateInfraRoot`; drop `infraRoot` if unused.

`claude_md.ts:522-527`: in the template string, change the two paths:

```
The dropdown is populated from \`~/.sandbox/infra/proxy/features.json\` (a static file served by Caddy), which is regenerated alongside the Caddyfile. ...
```
and
```
jq '[.[].name]' "$HOME/.sandbox/infra/proxy/features.json"
```
(`$HOME` inside this template literal needs no escaping; the existing `\${SANDBOX_ROOT...}` escape goes away with it.)

`proxy_reload.ts:26`:
```ts
        "and inspect ~/.sandbox/infra/proxy/Caddyfile.",
```

- [ ] **Step 6: Run the done-check grep, typecheck, and both suites**

Run:
```bash
cd packages/sandbox-core && npx tsc --noEmit && npx tsc && npm test 2>&1 | tail -8 && \
cd ../../apps/cli && npx tsc --noEmit && npx vitest run 2>&1 | tail -8 && \
cd ../.. && grep -rn "proxy/Caddyfile\|k8s-port-forward/tmp\|proxy/ui/features" packages/sandbox-core/*.ts apps/cli/src
```
Expected: both typechecks clean, both suites pass. The grep shows only the `claude_md.ts` and `proxy_reload.ts` user-facing strings (now `~/.sandbox/infra/...`) and nothing built from `infraRoot()`. `claude-md.test.mjs` may assert the old features.json text; if it does, update its expectation to the new path.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/generate.ts packages/sandbox-core/infra.ts packages/sandbox-core/caddy.ts packages/sandbox-core/claude_md.ts apps/cli/src/commands/proxy_reload.ts apps/cli/src/lib/__tests__/generate.test.ts
git commit -m "feat(core): Caddyfile, features.json and kubeconfig are generated under ~/.sandbox/infra

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Plugin skills and docs follow the path

**Files:**
- Modify: `plugins/sandbox-tools/skills/sandbox-diagnose/SKILL.md:79-80, 95, 133-134`
- Modify: `plugins/sandbox-tools/skills/sandbox-caddy-reload/SKILL.md:48-49, 75, 113-114`
- Modify: `plugins/sandbox-tools/skills/sandbox-routing-test/SKILL.md:64-65, 71-72`
- Modify: `plugins/sandbox-tools/skills/sandbox-status/SKILL.md:59-61`
- Modify: `docs/users-guide.md:385, 766, 1196-1200, 1353, 1531, 1687`
- Modify: `docs/known-issues.md:158, 201, 203, 213, 317-321, 495, 520, 525`
- Modify: `docs/troubleshooting-advanced.md:46, 144, 151`

**Interfaces:**
- Consumes: the path contract from Global Constraints. Skills run in a shell with no guarantee that `env.sh` was sourced, so they derive the path from `SANDBOX_CONFIG_FILE` when set, else `$HOME/.sandbox`.

- [ ] **Step 1: Define the shell snippet once and apply it to all four skills**

Every `SANDBOX_ROOT="$(dirname "$(readlink -f "$(command -v sandbox)")")"` line whose only purpose was the Caddyfile path becomes:

```bash
CADDYFILE="${SANDBOX_CONFIG_FILE:+$(dirname "$SANDBOX_CONFIG_FILE")}"
CADDYFILE="${CADDYFILE:-$HOME/.sandbox}/infra/proxy/Caddyfile"
```

and every `"$SANDBOX_ROOT/infra/proxy/Caddyfile"` becomes `"$CADDYFILE"`. Concretely:

`sandbox-diagnose/SKILL.md`
- `:79-80` →
  ```bash
  CADDYFILE="${SANDBOX_CONFIG_FILE:+$(dirname "$SANDBOX_CONFIG_FILE")}"
  CADDYFILE="${CADDYFILE:-$HOME/.sandbox}/infra/proxy/Caddyfile"
  docker cp "$CADDYFILE" sandbox-caddy:/tmp/Caddyfile.check
  ```
- `:95` → `` `grep -c 'reverse_proxy ' "$CADDYFILE"` — there is no ``
- `:133-134` → the two `CADDYFILE=` lines, then `HOST_SIZE=$(wc -c < "$CADDYFILE")`

`sandbox-caddy-reload/SKILL.md`
- `:48-49` → the two `CADDYFILE=` lines, then `docker cp "$CADDYFILE" sandbox-caddy:/tmp/Caddyfile.new`
- `:75` → `` (`grep -c 'reverse_proxy ' "$CADDYFILE"`). These two ``
- `:113-114` → the two `CADDYFILE=` lines, then `HOST_SIZE=$(wc -c < "$CADDYFILE")`

`sandbox-routing-test/SKILL.md`
- `:64-65` → the two `CADDYFILE=` lines, then `grep -n "path.*{relevant_pattern}" "$CADDYFILE"`
- `:71-72` → the two `CADDYFILE=` lines, then `docker cp "$CADDYFILE" sandbox-caddy:/tmp/Caddyfile.check`

`sandbox-status/SKILL.md`
- `:59-61` → the two `CADDYFILE=` lines, then `HOST_SIZE=$(wc -c < "$CADDYFILE" 2>/dev/null)`

Verify no `SANDBOX_ROOT` remains in the skills: `grep -rn SANDBOX_ROOT plugins/sandbox-tools/skills` returns nothing.

- [ ] **Step 2: Update `docs/users-guide.md`**

- `:385` → `7. Regenerates \`~/.sandbox/infra/proxy/Caddyfile\` and reloads Caddy`
- `:766` → replace `` `infra/proxy/Caddyfile` `` with `` `~/.sandbox/infra/proxy/Caddyfile` ``
- `:1196-1200` → replace the paragraph with:
  ```
  Both runtime consumers of this table are **generated** from `services.yaml` by
  `sandbox connect` (`packages/sandbox-core/k8s_forwards.ts`) under `~/.sandbox/infra/`:
  the container's forward list is written to `k8s-port-forward/forwards` (mounted at
  `/tmp/forwards`, read by `entrypoint.sh`), and the `k8s-forwards` service's
  `ports:`/`aliases:` are written to `compose/k8s-forwards.override.yml`, which every
  `docker compose` call the CLI makes passes as a second `-f`. The shipped
  `shared-infra.yml` is never modified.
  ```
- `:1353` → `| \`~/.sandbox/infra/proxy/Caddyfile\` | Generated Caddy config (never inside the package) |`
- `:1531` → `cat ~/.sandbox/infra/proxy/Caddyfile | grep -A 5 "PROJ-1234"`
- `:1687` → `    └── 6. Update proxy → ~/.sandbox/infra/proxy/Caddyfile → caddy reload`

- [ ] **Step 3: Update `docs/known-issues.md`**

These are incident records. Keep the historical text and add the current location:

- `:158` → `**Affects:** \`~/.sandbox/infra/proxy/Caddyfile\` (formerly \`apps/cli/infra/proxy/Caddyfile\`), \`apps/cli/infra/templates/Caddyfile.njk\`, \`packages/sandbox-core/generate.ts\``
- `:201` → `**Affects:** \`~/.sandbox/infra/proxy/Caddyfile\` (bind-mounted into \`sandbox-caddy\` container; was \`apps/cli/infra/proxy/Caddyfile\`)`
- `:203` → replace `` The `apps/cli/infra/proxy/Caddyfile` file `` with `` The generated `~/.sandbox/infra/proxy/Caddyfile` ``
- `:213` → `docker cp ~/.sandbox/infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile`
- `:317-321` → replace the paragraph with:
  ```
  Generated state used to live *inside* that package tree: `apps/cli/infra/proxy/Caddyfile`
  and `apps/cli/infra/proxy/ui/features.json` were gitignored build products under a
  directory that ships in the published package, so reinstalling or upgrading
  `werkmeister` could discard or stale them. Resolved 2026-10-01: everything
  `sandbox connect` generates now lives under `~/.sandbox/infra/`
  (`docs/superpowers/specs/2026-10-01-generated-state-dir-design.md`).
  ```
- `:495`, `:520`, `:525` → append ` (now \`~/.sandbox/infra/proxy/Caddyfile\`)` after the first mention of `infra/proxy/Caddyfile` in each line.

- [ ] **Step 4: Update `docs/troubleshooting-advanced.md`**

`:46`, `:144`, `:151` → `docker cp ~/.sandbox/infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile`

- [ ] **Step 5: Verify**

Run:
```bash
grep -rn "SANDBOX_ROOT" plugins/sandbox-tools/skills ; \
grep -rn -E "(^|[^~.])infra/proxy/Caddyfile|k8s-port-forward/tmp|proxy/ui/features" docs/users-guide.md docs/troubleshooting-advanced.md plugins/sandbox-tools/skills
```
Expected: both empty. (`known-issues.md` legitimately keeps the old path in historical text.)

- [ ] **Step 6: Commit**

```bash
git add plugins/sandbox-tools/skills docs/users-guide.md docs/known-issues.md docs/troubleshooting-advanced.md
git commit -m "docs: skills and guides read the Caddyfile from ~/.sandbox/infra

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Repository hygiene and the changeset

**Files:**
- Modify: `.gitignore`
- Modify: `apps/cli/package.json:12-24`
- Delete from index: `apps/cli/infra/compose/k8s-port-forward/tmp/kubeconfig`, `apps/cli/infra/compose/k8s-port-forward/tmp/forwards`
- Create: `.changeset/generated-state-dir.md`

- [ ] **Step 1: Untrack the generated files and ignore the directory**

```bash
git rm --cached apps/cli/infra/compose/k8s-port-forward/tmp/kubeconfig apps/cli/infra/compose/k8s-port-forward/tmp/forwards
```

In `.gitignore`, replace the block

```
# Auto-generated by the sandbox CLI (proxy-reload / feature changes)
apps/cli/infra/proxy/Caddyfile
apps/cli/infra/proxy/ui/features.json
```

with

```
# Generated by older CLI versions into the checkout; current versions write
# under ~/.sandbox/infra instead. Kept so a pre-move checkout stays clean.
apps/cli/infra/proxy/Caddyfile
apps/cli/infra/proxy/ui/features.json
apps/cli/infra/compose/k8s-port-forward/tmp/
```

- [ ] **Step 2: Simplify the package `files` list**

In `apps/cli/package.json` replace the `//files` comment and `files` array with:

```json
  "//files": "dist/ is gitignored build output, and npm drops gitignored paths unless an explicit list opts them back in. Nothing under infra/ is generated at runtime any more (that lives in ~/.sandbox/infra), so the list needs no negations beyond the sourcemaps.",
  "files": [
    "dist",
    "!dist/**/*.map",
    "infra",
    "bin",
    "sandbox",
    "README.md",
    "CONVENTIONS.md"
  ],
```

- [ ] **Step 3: Verify the tarball**

Run: `cd apps/cli && npm pack --dry-run 2>&1 | grep -E "tmp/|proxy/|total files"`
Expected: the only `proxy/` entry is `infra/proxy/ui/index.html`; no `tmp/` entry; total files 28 (unchanged from the previous release's count, since the negated files were never in it).

- [ ] **Step 4: Write the changeset**

Create `.changeset/generated-state-dir.md`:

```markdown
---
"werkmeister": minor
---

Everything `sandbox connect` generates now lives under `~/.sandbox/infra/` instead of inside the CLI package: the Caddyfile, `features.json`, the pinned kubeconfig, the k8s forwards table, and (new) a `compose/k8s-forwards.override.yml` carrying the `k8s-forwards` ports and aliases that used to be rewritten in place inside `shared-infra.yml`. A global `npm install -g` therefore works on a root-owned prefix, and an upgrade no longer deletes a file a running container is mounting. **After upgrading, run `sandbox connect` once**: `docker compose` recreates `sandbox-caddy` and `k8s-forwards` on the new mount paths. The `sandbox-tools` skills read the Caddyfile from the new location.
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore apps/cli/package.json .changeset/generated-state-dir.md
git commit -m "chore: untrack generated k8s-port-forward files; package needs no runtime negations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification from a package layout

**Files:** none modified. This task proves the spec's manual check.

- [ ] **Step 1: Full build and both suites**

Run from the repo root:
```bash
npx turbo run build typecheck test --filter=sandbox-core --filter=werkmeister 2>&1 | tail -15
```
Expected: all green.

- [ ] **Step 2: Pack and unpack into a fake global install**

```bash
S=$(mktemp -d) && mkdir -p "$S/pkg/node_modules" "$S/home" && \
(cd apps/cli && npm pack --pack-destination "$S" >/dev/null) && \
tar -xzf "$S"/werkmeister-*.tgz -C "$S/pkg/node_modules" && \
mv "$S/pkg/node_modules/package" "$S/pkg/node_modules/werkmeister" && \
ln -s "$PWD/node_modules/dockerode" "$S/pkg/node_modules/dockerode" && \
cp apps/cli/src/lib/__tests__/fixtures/services.yaml apps/cli/src/lib/__tests__/fixtures/ports.yaml "$S/home/" && \
PKG="$S/pkg/node_modules/werkmeister" && \
find "$PKG/infra" -type f | sort > "$S/before.txt" && echo "staged in $S"
```

- [ ] **Step 3: Generate from the package with the state dir relocated**

```bash
env -u SANDBOX_ROOT SANDBOX_CONFIG_FILE="$S/home/config.yaml" "$PKG/sandbox" proxy-reload 2>&1 | head -5
echo "--- generated:"; find "$S/home/infra" -type f
echo "--- package tree unchanged:"; find "$PKG/infra" -type f | sort | diff "$S/before.txt" - && echo OK
```
Expected: `proxy-reload` writes `$S/home/infra/proxy/Caddyfile` and `features.json` (it may then fail at the Docker step if Docker is not running; that is after the write). The `find` lists those two files plus, if `connect` logic ran, the `k8s-port-forward/forwards` and `compose/k8s-forwards.override.yml`. The `diff` prints nothing and `OK`.

- [ ] **Step 4: Compose config renders with the override and the env**

`proxy-reload` does not run `generateK8sForwards`, so first let `composeInvocation()` create the override the way a fresh machine's first `status` would:

```bash
env -u SANDBOX_ROOT SANDBOX_CONFIG_FILE="$S/home/config.yaml" "$PKG/sandbox" status >/dev/null 2>&1
test -f "$S/home/infra/compose/k8s-forwards.override.yml" && echo "override created"
SANDBOX_STATE_DIR="$S/home/infra" docker compose \
  -f "$PKG/infra/compose/shared-infra.yml" \
  -f "$S/home/infra/compose/k8s-forwards.override.yml" \
  config 2>&1 | grep -E "Caddyfile|features.json|kubeconfig|/tmp/forwards|published|k8s-" | head -20
```
Expected: `override created`, then (needs the Docker CLI; if it is absent, say so in the hand-off) the rendered config shows absolute `$S/home/infra/...` sources for the four generated mounts, the override's `published:` ports, and `k8s-<name>` aliases merged under `k8s-forwards`.

- [ ] **Step 5: Clean up and record**

```bash
rm -rf "$S"
```

Note the result of Steps 3 and 4 in the PR description or hand-off message, including whether Docker was available for Step 4.
