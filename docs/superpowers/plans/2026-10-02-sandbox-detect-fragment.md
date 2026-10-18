# `sandbox detect` Fragment Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old `sandbox detect` with a command that writes a runnable `<repo>/.sandbox/services.yaml` from what the repo already contains, and that only fills gaps on re-runs.

**Architecture:** A deterministic pipeline in `packages/sandbox-core/fragment_detect/`. Detectors turn files into `Finding`s, `correlate` groups findings into services, `precedence` picks one value per field, `allocate` assigns ports, and `render` splices the result into the existing file's text. An optional Claude pass, run through an injected `Resolver`, answers only the questions the pipeline flags. The CLI command and the MCP tool are thin wrappers.

**Tech Stack:** TypeScript (ESM), `yaml` 2.9, `ajv` 8, `node:test` for core and vitest for the CLI, `@anthropic-ai/claude-agent-sdk` (CLI only, loaded with a dynamic import), esbuild bundle.

**Spec:** `docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md`. Read it before starting any task. This plan implements it and argues from it.

## Global Constraints

- `packages/sandbox-core` never writes to the console (`console.*`); the MCP servers use stdout as their transport. Return data and let the CLI print it. `apps/cli/src/lib/__tests__/core_console_writes.test.ts` enforces this, and Task 1 extends it to `fragment_detect/`.
- `packages/sandbox-core` never spawns the `sandbox` CLI.
- A fragment's top-level keys are only `services`, `setup_services` and `infrastructure`.
- `port_offset` is `< ports_per_slot`, read from `~/.sandbox/ports.yaml`, default **20**. `k8s_forward_port` allocation starts at **9050**.
- Output is deterministic: the same repo and the same other fragments give byte-identical YAML. Sort every list you build from a set or a directory listing.
- Existing fragment text is never modified. Re-runs only insert new keys and entries. Every byte of the original survives, in order.
- The Claude pass uses model `claude-opus-5-5`, tools `Read`, `Glob` and `Grep` only, and `permissionMode: "dontAsk"`. It is off unless the user agrees or passes `--assist`, and it never runs in tests.
- New dependencies: `ajv@^8.20.0` in `sandbox-core`, and `@anthropic-ai/claude-agent-sdk@^0.3.288` in `apps/cli` only, marked `external` in `apps/cli/esbuild.mjs`. Nothing else.
- Node `>=20`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Undeclared `node_modules`.** A repo whose `node_modules` (or a nested one) isn't gitignored must not produce services from vendored `Dockerfile`s or `package.json`s. Test in Task 1 (`listRepoFiles drops node_modules even when git lists it`).
2. **Dockerfile shapes seen in practice.** `FROM ${BASE}`, `FROM --platform=… img AS build`, CRLF line endings and `\` continuations must not crash, and must not produce a bogus image. Tests in Task 3.
3. **Partial k8s manifests.** A Deployment with no ports, probes or resources, a `kind: List`, and a Service in a different file from its Deployment must all work, and a non-k8s YAML file must stay silent. Tests in Task 5.
4. **Odd existing fragments.** An empty or comment-only file, a fragment using `x-` anchors and flow sequences, and an existing service whose `setup_service` has a different name must all gap-fill without altering a byte and without adding a duplicate install service. Tests in Task 9.
5. **A workspace package with no `name`.** The `test` command must still be usable (`npm test -w <dir>`). Test in Task 2.

## Conventions for every task

- Core tests are `node:test` files at `packages/sandbox-core/fragment-detect-*.test.mjs`. They import from `./dist/fragment_detect/index.js`, so build before running them:
  `cd packages/sandbox-core && npx tsc && node --test fragment-detect-<area>.test.mjs`
- Fixture repos are written by the `fixture()` helper (Task 1) into a temp dir, so each test shows its files inline. This replaces the spec's on-disk `fixtures/fragment-detect/<case>/` directories; the cases are the same.
- Every module in `fragment_detect/` is re-exported from `fragment_detect/index.ts` with `export * from "./<module>.js";`. Only module-level `export`s are public, so keep helpers unexported unless another module needs them.
- Paths inside a repo are repo-relative POSIX strings (`apps/backend/package.json`), and `"."` means the repo root.

---

### Task 1: Scaffolding, file listing and the workspace detector

**Files:**
- Create: `packages/sandbox-core/fragment_detect/types.ts`
- Create: `packages/sandbox-core/fragment_detect/files.ts`
- Create: `packages/sandbox-core/fragment_detect/workspace.ts`
- Create: `packages/sandbox-core/fragment_detect/index.ts`
- Create: `packages/sandbox-core/fragment-detect-helpers.mjs`
- Test: `packages/sandbox-core/fragment-detect-workspace.test.mjs`
- Modify: `packages/sandbox-core/tsconfig.json` (`include`)
- Modify: `packages/sandbox-core/package.json` (`exports`)
- Modify: `apps/cli/src/lib/__tests__/core_console_writes.test.ts:25-31`

**Interfaces:**
- Consumes: `Runner` from `packages/sandbox-core/machine_setup.ts` (`(cmd: string[]) => [number, string]`), and `run`/`ProcError` from `packages/sandbox-core/proc.ts`.
- Produces:
  - Types: `Confidence`, `FieldValue`, `FindingKind`, `Finding`, `Skipped`, `DetectContext`, `PackageManager`, `Workspace`.
  - `stated(value, source): FieldValue`, `guessed(value, source): FieldValue`
  - `listRepoFiles(root: string, runner: Runner): string[]`
  - `readText(ctx, rel): string`, `readJson(ctx, rel): Record<string, any> | null`, `yamlDocs(text): unknown[]`
  - `stdoutRunner(cmd: string[]): [number, string]`
  - `expandWorkspaceGlobs(patterns: string[], files: string[]): string[]`
  - `detectWorkspace(ctx: DetectContext, existingSetupName?: string | null): Workspace`
  - Test helpers: `noTools`, `fixture(files, name?)`, `ctxFor(root, runner?)`

- [ ] **Step 1: Wire the new directory into the build and exports**

In `packages/sandbox-core/tsconfig.json`, change the `include` line to:

```jsonc
  "include": ["*.ts", "strategies/*.ts", "fragment_detect/*.ts"]
```

In `packages/sandbox-core/package.json` `exports`, add this line after `"./form_schema"`:

```json
    "./fragment_detect": "./dist/fragment_detect/index.js",
```

- [ ] **Step 2: Extend the console-writes guard to the new directory**

In `apps/cli/src/lib/__tests__/core_console_writes.test.ts`, replace the `offenders` computation (the `fs.readdirSync(CORE)…` chain inside the `it`) with:

```ts
    const files = [
      ...fs.readdirSync(CORE).filter((f) => f.endsWith(".ts")),
      ...(fs.existsSync(path.join(CORE, "fragment_detect"))
        ? fs.readdirSync(path.join(CORE, "fragment_detect"))
            .filter((f) => f.endsWith(".ts"))
            .map((f) => `fragment_detect/${f}`)
        : []),
    ];
    const offenders = files
      .filter((f) => !f.endsWith(".d.ts") && !ALLOWED.has(f))
      .filter((f) => /\bconsole\.\w+\(/.test(fs.readFileSync(path.join(CORE, f), "utf8")));
```

- [ ] **Step 3: Write the test helpers**

`packages/sandbox-core/fragment-detect-helpers.mjs`:

```js
// Shared fixtures for the fragment-detect tests. Not a test file: the
// `*.test.mjs` glob skips it.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listRepoFiles } from "./dist/fragment_detect/index.js";

/** No git, no helm, no kubectl: every tool reads as missing. */
export const noTools = (cmd) =>
  cmd[0] === "git" ? [128, "fatal: not a git repository"] : [127, `${cmd[0]}: command not found`];

/**
 * Write *files* under a fresh `<tmp>/<name>` and return that path. A value is
 * written as-is when it is a string and as pretty JSON otherwise.
 */
export function fixture(files, name = "repo") {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "fragment-detect-")), name);
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

/** A DetectContext over *root*, as planFragment builds it. */
export function ctxFor(root, runner = noTools) {
  return { root, files: listRepoFiles(root, runner), runner, skipped: [] };
}
```

- [ ] **Step 4: Write the failing tests**

`packages/sandbox-core/fragment-detect-workspace.test.mjs`:

```js
// The first two stages every detection run depends on: which files exist,
// and which directories are workspace packages.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectWorkspace, expandWorkspaceGlobs, listRepoFiles } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture, noTools } from "./fragment-detect-helpers.mjs";

test("listRepoFiles walks a non-git dir, pruning node_modules and dot dirs but keeping dotfiles", () => {
  const root = fixture({
    "package.json": {},
    ".nvmrc": "22\n",
    "node_modules/x/Dockerfile": "FROM x",
    ".github/workflows/ci.yml": "on: push",
    "apps/a/package.json": {},
  });
  assert.deepEqual(listRepoFiles(root, noTools), [".nvmrc", "apps/a/package.json", "package.json"]);
});

test("listRepoFiles drops node_modules even when git lists it", () => {
  const root = fixture({ "package.json": {}, "node_modules/x/Dockerfile": "FROM x" });
  const git = (cmd) => (cmd[0] === "git" ? [0, "node_modules/x/Dockerfile\npackage.json\n"] : [127, ""]);
  assert.deepEqual(listRepoFiles(root, git), ["package.json"]);
});

test("npm workspaces give the package dirs and a shared install named after the repo", () => {
  const root = fixture(
    {
      "package.json": { workspaces: ["apps/*"] },
      "package-lock.json": "{}",
      "apps/backend/package.json": { name: "backend" },
      "apps/frontend/package.json": { name: "frontend" },
      "tools/x/package.json": { name: "x" },
    },
    "demo-services",
  );
  const ws = detectWorkspace(ctxFor(root));
  assert.equal(ws.pm, "npm");
  assert.deepEqual(ws.packageDirs, ["apps/backend", "apps/frontend"]);
  assert.equal(ws.setupName, "demo-services-install");
  assert.equal(ws.setupFields.command.value, "npm install");
  assert.equal(ws.setupFields.node_modules_volume.value, "node-modules");
});

test("pnpm-workspace.yaml selects pnpm and its package globs", () => {
  const root = fixture({
    "package.json": { name: "root" },
    "pnpm-workspace.yaml": "packages:\n  - 'services/**'\n",
    "services/api/package.json": { name: "api" },
    "services/group/worker/package.json": { name: "worker" },
  });
  const ws = detectWorkspace(ctxFor(root));
  assert.equal(ws.pm, "pnpm");
  assert.deepEqual(ws.packageDirs, ["services/api", "services/group/worker"]);
  assert.equal(ws.setupFields.command.value, "corepack enable && pnpm install");
});

test("negated workspace patterns exclude", () => {
  const files = ["packages/a/package.json", "packages/legacy/package.json"];
  assert.deepEqual(expandWorkspaceGlobs(["packages/*", "!packages/legacy"], files), ["packages/a"]);
});

test("no root package.json means no workspace and no setup service", () => {
  const ws = detectWorkspace(ctxFor(fixture({ "Dockerfile": "FROM golang:1.23" })));
  assert.deepEqual(ws.packageDirs, []);
  assert.equal(ws.setupName, null);
});

test("a single-package repo still gets a setup service", () => {
  const ws = detectWorkspace(ctxFor(fixture({ "package.json": { name: "shop" } }, "shop")));
  assert.deepEqual(ws.packageDirs, []);
  assert.equal(ws.setupName, "shop-install");
});

test("an existing fragment's setup service name is reused", () => {
  const root = fixture({ "package.json": { workspaces: ["apps/*"] } }, "demo-services");
  assert.equal(detectWorkspace(ctxFor(root), "demo-install").setupName, "demo-install");
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-workspace.test.mjs`
Expected: FAIL with `Cannot find module '.../dist/fragment_detect/index.js'`.

- [ ] **Step 6: Write `types.ts`**

```ts
/**
 * Shared shapes for `sandbox detect`. Detectors emit Findings, correlation
 * groups them into services, and precedence turns each group into fields.
 * See docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md.
 */
import type { Runner } from "../machine_setup.js";

export type Confidence = "stated" | "guessed" | "inferred";

/** One field value and where it came from. For a guess, `source` is the reason written as the YAML comment. */
export interface FieldValue {
  value: unknown;
  source: string;
  confidence: Confidence;
}

export type FindingKind = "package" | "dockerfile" | "k8s" | "compose";

/** What one file says about one would-be service, before correlation. */
export interface Finding {
  kind: FindingKind;
  /** Candidate service name: package dir basename, Deployment/release name or compose service name. */
  name: string;
  /** Repo-relative directory the finding is anchored to ("." is the repo root), or null. */
  dir: string | null;
  /** Repo-relative file it came from (or a label such as `x.values.yaml (helm template)`). */
  file: string;
  /** Container image, used for matching and datastore detection (k8s, compose). */
  image?: string;
  /** Package findings only: has a `dev` or `start` script. */
  runnable?: boolean;
  fields: Record<string, FieldValue>;
}

export interface Skipped {
  item: string;
  reason: string;
}

export interface DetectContext {
  /** Absolute repo root. */
  root: string;
  /** Repo-relative POSIX paths, sorted. */
  files: string[];
  runner: Runner;
  /** Detectors record a bad file here instead of throwing. */
  skipped: Skipped[];
}

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface Workspace {
  pm: PackageManager;
  /** Repo-relative package dirs; [] when the repo has no workspaces. */
  packageDirs: string[];
  /** The shared install setup service, or null when there is no root package.json. */
  setupName: string | null;
  setupFields: Record<string, FieldValue>;
}

export function stated(value: unknown, source: string): FieldValue {
  return { value, source, confidence: "stated" };
}

export function guessed(value: unknown, source: string): FieldValue {
  return { value, source, confidence: "guessed" };
}
```

- [ ] **Step 7: Write `files.ts`**

```ts
/** Reading a repo for detection: the file list, and text/JSON/YAML readers. */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseAllDocuments } from "yaml";

import type { Runner } from "../machine_setup.js";
import { ProcError, run } from "../proc.js";
import type { DetectContext } from "./types.js";

/** Dependencies and dot directories are never scanned; dotfiles such as .nvmrc are. */
function pruned(rel: string): boolean {
  const segs = rel.split("/");
  return segs.some((seg, i) => seg === "node_modules" || (i < segs.length - 1 && seg.startsWith(".")));
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      out.push(...walk(root, child));
    } else if (ent.isFile()) {
      out.push(child);
    }
  }
  return out;
}

/** Every file in the repo, repo-relative and sorted: git's view when it is a repo, a directory walk otherwise. */
export function listRepoFiles(root: string, runner: Runner): string[] {
  const [rc, out] = runner(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"]);
  const files = rc === 0 ? out.split("\n").map((l) => l.trim()).filter(Boolean) : walk(root);
  // --cached lists tracked files deleted from the working tree.
  return files.filter((f) => !pruned(f) && fs.existsSync(path.join(root, f))).sort();
}

export function readText(ctx: DetectContext, rel: string): string {
  return fs.readFileSync(path.join(ctx.root, rel), "utf8");
}

/** A JSON object file, or null when the repo has no such file. Malformed JSON throws. */
export function readJson(ctx: DetectContext, rel: string): Record<string, any> | null {
  if (!ctx.files.includes(rel)) return null;
  const data = JSON.parse(readText(ctx, rel));
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

/** Every document in a YAML stream. A stream that doesn't parse throws with the parser's message. */
export function yamlDocs(text: string): unknown[] {
  return parseAllDocuments(text).map((doc) => {
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    return doc.toJS();
  });
}

/**
 * A Runner whose output is stdout alone on success. helm and kubectl print
 * warnings on stderr, which must not reach the YAML parser; on failure the
 * output is stderr, for the skipped-item message.
 */
export function stdoutRunner(cmd: string[]): [number, string] {
  try {
    const res = run(cmd, { capture: true, timeout: 120 });
    return [res.status, res.status === 0 ? res.stdout || "" : (res.stderr || res.stdout || "").trim()];
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") return [127, `${cmd[0]}: command not found`];
    if (e instanceof ProcError && e.code === "ETIMEDOUT") return [124, `${cmd.join(" ")}: timed out`];
    throw e;
  }
}
```

- [ ] **Step 8: Write `workspace.ts`**

```ts
/** Workspace detection: the package manager, the package dirs and the shared install service. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readJson, readText } from "./files.js";
import { stated, type DetectContext, type PackageManager, type Workspace } from "./types.js";

const INSTALL: Record<PackageManager, string> = {
  npm: "npm install",
  pnpm: "corepack enable && pnpm install",
  yarn: "corepack enable && yarn install",
};

/** Glob patterns from `workspaces` / `pnpm-workspace.yaml` → the package dirs present in *files*. */
export function expandWorkspaceGlobs(patterns: string[], files: string[]): string[] {
  const toRe = (pattern: string) =>
    new RegExp(
      "^" +
        pattern
          .replace(/^\.\//, "")
          .replace(/\/+$/, "")
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\0")
          .replace(/\*/g, "[^/]+")
          .replace(/\0/g, ".+") +
        "$",
    );
  const include = patterns.filter((p) => !p.startsWith("!")).map(toRe);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => toRe(p.slice(1)));
  return files
    .filter((f) => f.endsWith("/package.json"))
    .map((f) => path.posix.dirname(f))
    .filter((d) => include.some((r) => r.test(d)) && !exclude.some((r) => r.test(d)))
    .sort();
}

/**
 * The workspace shape. *existingSetupName* is the `setup_service` an existing
 * fragment already uses, so a re-run doesn't add a second install service
 * under a new name.
 */
export function detectWorkspace(ctx: DetectContext, existingSetupName: string | null = null): Workspace {
  const has = (f: string) => ctx.files.includes(f);
  const pm: PackageManager =
    has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  const rootPkg = readJson(ctx, "package.json");
  if (!rootPkg) return { pm, packageDirs: [], setupName: null, setupFields: {} };

  let patterns: string[] = [];
  let source = "package.json";
  if (has("pnpm-workspace.yaml")) {
    const packages = parseYaml(readText(ctx, "pnpm-workspace.yaml"))?.packages;
    patterns = Array.isArray(packages) ? packages.map(String) : [];
    source = "pnpm-workspace.yaml";
  } else {
    const ws = rootPkg["workspaces"];
    patterns = Array.isArray(ws) ? ws.map(String) : Array.isArray(ws?.packages) ? ws.packages.map(String) : [];
    if (patterns.length) source = "package.json → workspaces";
  }
  return {
    pm,
    packageDirs: expandWorkspaceGlobs(patterns, ctx.files),
    setupName: existingSetupName ?? `${path.basename(ctx.root)}-install`,
    setupFields: {
      command: stated(INSTALL[pm], `${source} (${pm})`),
      node_modules_volume: stated("node-modules", source),
    },
  };
}
```

- [ ] **Step 9: Write `index.ts`**

```ts
/**
 * `sandbox detect`: generate a repo's `.sandbox/services.yaml` fragment.
 * See docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md.
 */
export * from "./types.js";
export * from "./files.js";
export * from "./workspace.js";
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-workspace.test.mjs`
Expected: PASS, 8 tests.

Run: `cd apps/cli && npx vitest run src/lib/__tests__/core_console_writes.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/sandbox-core/fragment_detect packages/sandbox-core/fragment-detect-helpers.mjs \
  packages/sandbox-core/fragment-detect-workspace.test.mjs packages/sandbox-core/tsconfig.json \
  packages/sandbox-core/package.json apps/cli/src/lib/__tests__/core_console_writes.test.ts
git commit -m "feat(detect): fragment_detect scaffolding, repo file listing and workspace detection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Package detector

**Files:**
- Create: `packages/sandbox-core/fragment_detect/package.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-package.test.mjs`

**Interfaces:**
- Consumes (Task 1): `DetectContext`, `Workspace`, `Finding`, `stated`, `guessed`, `readJson`, `readText`.
- Produces: `detectPackages(ctx: DetectContext, ws: Workspace): Finding[]`. Each package finding has `kind: "package"`, `dir`, `runnable`, and fields `command?`, `test?`, `type`, `archetype`, `image` (always guessed), `setup_service?`, `node_modules_volume?`.

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-package.test.mjs`:

```js
// package.json → command, test, type/archetype and a fallback image.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPackages, detectWorkspace } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

function run(files, name) {
  const ctx = ctxFor(fixture(files, name));
  return detectPackages(ctx, detectWorkspace(ctx));
}

test("a turbo monorepo: one finding per workspace package", () => {
  const found = run(
    {
      "package.json": { workspaces: ["apps/*"], engines: { node: ">=20" } },
      "apps/backend/package.json": {
        name: "backend",
        scripts: { dev: "node server.js", start: "node server.js", test: "vitest run" },
        dependencies: { pg: "^8" },
      },
      "apps/frontend/package.json": {
        name: "frontend",
        scripts: { dev: "next dev", test: "vitest run" },
        dependencies: { next: "15" },
      },
    },
    "demo-services",
  );
  assert.deepEqual(found.map((f) => [f.name, f.dir]), [["backend", "apps/backend"], ["frontend", "apps/frontend"]]);
  const [backend, frontend] = found;
  assert.equal(backend.fields.command.value, "cd apps/backend && exec npm run dev");
  assert.equal(backend.fields.test.value, "npm test -w backend");
  assert.equal(backend.fields.type.value, "api");
  assert.equal(backend.fields.type.confidence, "guessed");
  assert.equal(backend.fields.image.value, "node:20-alpine");
  assert.equal(backend.fields.setup_service.value, "demo-services-install");
  assert.equal(backend.runnable, true);
  assert.equal(frontend.fields.type.value, "web");
  assert.equal(frontend.fields.archetype.value, "node-web");
  assert.equal(frontend.fields.type.confidence, "stated");
});

test("a single-package repo is one service at the root, named after the repo", () => {
  const [svc] = run(
    { "package.json": { name: "shop", scripts: { start: "node index.js", test: "node --test" }, dependencies: { express: "4" } } },
    "shop",
  );
  assert.equal(svc.name, "shop");
  assert.equal(svc.dir, ".");
  assert.equal(svc.fields.command.value, "exec npm run start");
  assert.equal(svc.fields.test.value, "npm test");
  assert.equal(svc.fields.archetype.value, "node-service");
});

test("a glibc-only dependency drops -alpine; .nvmrc sets the major", () => {
  const [svc] = run({ "package.json": { name: "img", dependencies: { sharp: "0.33" } }, ".nvmrc": "v24.1.0\n" });
  assert.equal(svc.fields.image.value, "node:24");
  assert.match(svc.fields.image.source, /sharp/);
});

test("a package with no name still gets a usable test command", () => {
  const found = run({
    "package.json": { workspaces: ["apps/*"] },
    "apps/x/package.json": { scripts: { test: "vitest" } },
  });
  assert.equal(found[0].fields.test.value, "npm test -w apps/x");
});

test("pnpm and yarn test commands go through the workspace", () => {
  const pnpm = run({
    "package.json": {},
    "pnpm-workspace.yaml": "packages: ['apps/*']\n",
    "apps/api/package.json": { name: "@acme/api", scripts: { test: "vitest" } },
  });
  assert.equal(pnpm[0].fields.test.value, "pnpm --filter @acme/api test");
  const yarn = run({
    "package.json": { workspaces: ["apps/*"] },
    "yarn.lock": "",
    "apps/api/package.json": { name: "api", scripts: { test: "jest" } },
  });
  assert.equal(yarn[0].fields.test.value, "yarn workspace api test");
});

test("a library with no dev/start script is not runnable; a bin makes a cli", () => {
  const found = run({
    "package.json": { workspaces: ["packages/*"] },
    "packages/utils/package.json": { name: "utils" },
    "packages/tool/package.json": { name: "tool", bin: { tool: "bin.js" } },
  });
  const utils = found.find((f) => f.name === "utils");
  const tool = found.find((f) => f.name === "tool");
  assert.equal(utils.runnable, false);
  assert.equal(tool.fields.type.value, "cli");
  assert.equal(tool.fields.archetype.value, "node-tool");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-package.test.mjs`
Expected: FAIL with `detectPackages is not a function` (or a SyntaxError on the missing export).

- [ ] **Step 3: Write `package.ts`**

```ts
/** package.json → the dev command, test command, type/archetype and a fallback image. */
import * as path from "node:path";

import { readJson, readText } from "./files.js";
import { guessed, stated, type DetectContext, type Finding, type Workspace } from "./types.js";

const WEB_DEPS = ["next", "vite", "react", "expo"];
const API_DEPS = ["express", "fastify", "@nestjs/core", "koa"];
/** Ship glibc-only prebuilds; an alpine image can't load them (users guide, "Self-hosting the sandbox repo"). */
const GLIBC_ONLY = ["sharp", "better-sqlite3", "esbuild", "@swc/core"];

function testCommand(ws: Workspace, dir: string, pkgName: string | undefined): string {
  if (dir === ".") return `${ws.pm} test`;
  const name = pkgName ?? dir;
  if (ws.pm === "pnpm") return `pnpm --filter ${name} test`;
  if (ws.pm === "yarn") return `yarn workspace ${name} test`;
  return `npm test -w ${name}`;
}

function nodeMajor(ctx: DetectContext, dir: string, pkg: Record<string, any>, rootPkg: Record<string, any> | null): string {
  for (const range of [pkg.engines?.node, rootPkg?.engines?.node]) {
    const m = /(\d+)/.exec(String(range ?? ""));
    if (m) return m[1];
  }
  for (const rc of [path.posix.join(dir, ".nvmrc"), ".nvmrc"]) {
    if (!ctx.files.includes(rc)) continue;
    const m = /(\d+)/.exec(readText(ctx, rc));
    if (m) return m[1];
  }
  return "22";
}

export function detectPackages(ctx: DetectContext, ws: Workspace): Finding[] {
  const rootPkg = readJson(ctx, "package.json");
  const dirs = ws.packageDirs.length ? ws.packageDirs : rootPkg ? ["."] : [];
  const out: Finding[] = [];
  for (const dir of dirs) {
    const file = dir === "." ? "package.json" : `${dir}/package.json`;
    const pkg = readJson(ctx, file);
    if (!pkg) continue;
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
    const fields: Finding["fields"] = {};

    const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
    if (script) {
      const runIt = `exec ${ws.pm} run ${script}`;
      fields.command = stated(dir === "." ? runIt : `cd ${dir} && ${runIt}`, `${file} → scripts.${script}`);
    }
    if (scripts.test) fields.test = stated(testCommand(ws, dir, pkg.name), `${file} → scripts.test`);

    const web = WEB_DEPS.find((d) => d in deps);
    const api = API_DEPS.find((d) => d in deps);
    const marker: [string, string, string] | null = web
      ? ["web", "node-web", `${file} → dependency ${web}`]
      : api
        ? ["api", "node-service", `${file} → dependency ${api}`]
        : pkg.bin
          ? ["cli", "node-tool", `${file} → bin`]
          : null;
    if (marker) {
      fields.type = stated(marker[0], marker[2]);
      fields.archetype = stated(marker[1], marker[2]);
    } else {
      const why = `no web, api or bin marker in ${file} — assumed a service`;
      fields.type = guessed("api", why);
      fields.archetype = guessed("node-service", why);
    }

    const glibc = GLIBC_ONLY.find((d) => d in deps);
    fields.image = guessed(
      `node:${nodeMajor(ctx, dir, pkg, rootPkg)}${glibc ? "" : "-alpine"}`,
      `no Dockerfile — Node major from engines/.nvmrc${glibc ? `; glibc image because of ${glibc}` : ""}`,
    );
    if (ws.setupName) {
      fields.setup_service = stated(ws.setupName, "shared workspace install");
      fields.node_modules_volume = stated("node-modules", "shared workspace install");
    }
    out.push({
      kind: "package",
      name: dir === "." ? path.basename(ctx.root) : path.posix.basename(dir),
      dir,
      file,
      runnable: Boolean(script),
      fields,
    });
  }
  return out;
}
```

- [ ] **Step 4: Export it**

Append to `packages/sandbox-core/fragment_detect/index.ts`:

```ts
export * from "./package.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-package.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/package.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-package.test.mjs
git commit -m "feat(detect): package.json detector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dockerfile detector

**Files:**
- Create: `packages/sandbox-core/fragment_detect/dockerfile.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-dockerfile.test.mjs`

**Interfaces:**
- Consumes (Task 1): `DetectContext`, `Finding`, `stated`, `guessed`, `readText`.
- Produces: `detectDockerfiles(ctx): Finding[]` (`kind: "dockerfile"`, fields `image?` stated, `internal_port?` stated, `command?` guessed), and `dockerInstructions(text): [string, string][]`.

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-dockerfile.test.mjs`:

```js
// Dockerfile → dev image (first FROM), port (EXPOSE), and a guessed command (CMD).
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDockerfiles } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

const detect = (files, name) => detectDockerfiles(ctxFor(fixture(files, name)));

test("the demo backend Dockerfile", () => {
  const [f] = detect({
    "apps/backend/Dockerfile":
      "# comment\nFROM node:22-alpine\nWORKDIR /app\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]\n",
  });
  assert.equal(f.name, "backend");
  assert.equal(f.dir, "apps/backend");
  assert.equal(f.fields.image.value, "node:22-alpine");
  assert.equal(f.fields.internal_port.value, 3000);
  assert.equal(f.fields.command.value, "cd apps/backend && exec node server.js");
  assert.equal(f.fields.command.confidence, "guessed");
});

test("multi-stage: the first FROM, skipping --platform and AS", () => {
  const [f] = detect({
    "Dockerfile": "FROM --platform=$BUILDPLATFORM golang:1.23 AS build\nRUN go build\nFROM gcr.io/distroless/base\nCMD [\"/api\"]\n",
  }, "api");
  assert.equal(f.dir, ".");
  assert.equal(f.name, "api");
  assert.equal(f.fields.image.value, "golang:1.23");
  assert.equal(f.fields.command.value, "/api");
});

test("FROM ${ARG} gives no image rather than a bogus one", () => {
  const [f] = detect({ "Dockerfile": "ARG BASE=node:22\nFROM ${BASE}\nEXPOSE 8080/tcp\n" });
  assert.equal(f.fields.image, undefined);
  assert.equal(f.fields.internal_port.value, 8080);
});

test("CRLF line endings and backslash continuations", () => {
  const [f] = detect({ "Dockerfile": "FROM python:3.12\r\nEXPOSE \\\r\n  5000\r\nCMD python \\\r\n  app.py\r\n" });
  assert.equal(f.fields.image.value, "python:3.12");
  assert.equal(f.fields.internal_port.value, 5000);
  assert.equal(f.fields.command.value.replace(/\s+/g, " "), "python app.py");
});

test("a dev Dockerfile is listed before the production one in the same dir", () => {
  const found = detect({
    "svc/Dockerfile": "FROM node:22-alpine\n",
    "svc/Dockerfile.dev": "FROM node:22\n",
  });
  assert.deepEqual(found.map((f) => f.file), ["svc/Dockerfile.dev", "svc/Dockerfile"]);
});

test("ENTRYPOINT stands in when there is no CMD", () => {
  const [f] = detect({ "Dockerfile": "FROM alpine\nENTRYPOINT [\"/bin/run\", \"--serve\"]\n" });
  assert.equal(f.fields.command.value, "/bin/run --serve");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-dockerfile.test.mjs`
Expected: FAIL (`detectDockerfiles` is not exported).

- [ ] **Step 3: Write `dockerfile.ts`**

```ts
/** Dockerfile → the dev image (first FROM), the port (EXPOSE) and a guessed command (CMD/ENTRYPOINT). */
import * as path from "node:path";

import { readText } from "./files.js";
import { guessed, stated, type DetectContext, type Finding } from "./types.js";

const DOCKERFILE = /^(Dockerfile(\..+)?|.+\.Dockerfile)$/;
const DEV = /(^|\.)dev(\.|$)/i;

/** [INSTRUCTION, argument] pairs, with continuations joined and comments dropped. */
export function dockerInstructions(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\w+)\s+(.*)$/.exec(line);
    if (m) out.push([m[1].toUpperCase(), m[2].trim()]);
  }
  return out;
}

/** `["node", "server.js"]` → `node server.js`; shell form is returned as written. */
function commandText(arg: string): string {
  if (arg.startsWith("[")) {
    try {
      const parts = JSON.parse(arg);
      if (Array.isArray(parts)) return parts.map(String).join(" ");
    } catch {
      // Not valid exec form: fall through to the raw text.
    }
  }
  return arg;
}

export function detectDockerfiles(ctx: DetectContext): Finding[] {
  const isDev = (f: string) => DEV.test(path.posix.basename(f));
  const files = ctx.files
    .filter((f) => DOCKERFILE.test(path.posix.basename(f)))
    .sort((a, b) => Number(isDev(b)) - Number(isDev(a)) || a.localeCompare(b));
  return files.map((file) => {
    const dir = path.posix.dirname(file);
    const ins = dockerInstructions(readText(ctx, file));
    const fields: Finding["fields"] = {};

    // The first stage is the build stage, which carries the toolchain a dev container needs.
    const from = ins.find(([k]) => k === "FROM");
    const image = from?.[1].split(/\s+/).find((t) => !t.startsWith("--"));
    if (image && !image.includes("$")) fields.image = stated(image, `${file} → FROM`);

    const expose = ins.find(([k]) => k === "EXPOSE");
    const port = Number(/(\d+)/.exec(expose?.[1] ?? "")?.[1]);
    if (Number.isInteger(port) && port > 0) fields.internal_port = stated(port, `${file} → EXPOSE`);

    const last = (k: string) => [...ins].reverse().find(([name]) => name === k);
    const cmd = last("CMD") ?? last("ENTRYPOINT");
    if (cmd) {
      const text = commandText(cmd[1]);
      fields.command = guessed(
        dir === "." ? text : `cd ${dir} && exec ${text}`,
        `${file} → ${cmd[0]} is the production entrypoint`,
      );
    }
    return {
      kind: "dockerfile",
      name: dir === "." ? path.basename(ctx.root) : path.posix.basename(dir),
      dir,
      file,
      fields,
    };
  });
}
```

- [ ] **Step 4: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./dockerfile.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-dockerfile.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/dockerfile.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-dockerfile.test.mjs
git commit -m "feat(detect): Dockerfile detector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Compose detector

**Files:**
- Create: `packages/sandbox-core/fragment_detect/compose.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-compose.test.mjs`

**Interfaces:**
- Consumes (Task 1): `DetectContext`, `Finding`, `stated`, `readText`.
- Produces: `COMPOSE_FILE: RegExp` (Task 5 uses it to exclude compose files), `containerPort(spec: unknown): number | undefined`, and `detectCompose(ctx): Finding[]` (`kind: "compose"`; `dir` from `build.context` or null; `image`; fields `environment?`, `depends_on?`, `command?`, `internal_port?`, `health_endpoint?`, all stated).

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-compose.test.mjs`:

```js
// docker-compose → environment, depends_on, command, port and health path per service.
import { test } from "node:test";
import assert from "node:assert/strict";

import { containerPort, detectCompose } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

const COMPOSE = `
services:
  api:
    build: ./apps/api
    command: ["npm", "run", "dev"]
    ports: ["8080:3000/tcp"]
    environment:
      - REDIS_URL=redis://redis:6379
      - EMPTY=
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
  web:
    build:
      context: apps/web
    expose: [5173]
    environment:
      API_URL: http://api:3000
      UNSET:
    depends_on: [api]
  redis:
    image: redis:7-alpine
    ports:
      - target: 6379
        published: 6379
`;

test("each compose service becomes a finding", () => {
  const ctx = ctxFor(fixture({ "docker-compose.yml": COMPOSE }));
  const found = detectCompose(ctx);
  assert.deepEqual(found.map((f) => [f.name, f.dir, f.image ?? null]), [
    ["api", "apps/api", null],
    ["web", "apps/web", null],
    ["redis", null, "redis:7-alpine"],
  ]);
  const [api, web, redis] = found;
  assert.equal(api.fields.command.value, "npm run dev");
  assert.equal(api.fields.internal_port.value, 3000);
  assert.deepEqual(api.fields.environment.value, { REDIS_URL: "redis://redis:6379", EMPTY: "" });
  assert.deepEqual(api.fields.depends_on.value, ["redis"]);
  assert.equal(api.fields.health_endpoint.value, "/healthz");
  assert.equal(web.fields.internal_port.value, 5173);
  assert.deepEqual(web.fields.environment.value, { API_URL: "http://api:3000" });
  assert.deepEqual(web.fields.depends_on.value, ["api"]);
  assert.equal(redis.fields.internal_port.value, 6379);
  assert.match(api.fields.environment.source, /docker-compose\.yml → services\.api\.environment/);
});

test("a root build context anchors to the repo root", () => {
  const ctx = ctxFor(fixture({ "compose.yaml": "services:\n  app:\n    build: .\n" }));
  assert.equal(detectCompose(ctx)[0].dir, ".");
});

test("port spec forms", () => {
  assert.equal(containerPort(3000), 3000);
  assert.equal(containerPort("3000"), 3000);
  assert.equal(containerPort("127.0.0.1:8080:3000"), 3000);
  assert.equal(containerPort("9000-9001:9000-9001"), 9000);
  assert.equal(containerPort({ target: 80 }), 80);
  assert.equal(containerPort("abc"), undefined);
});

test("an unparsable compose file is skipped, not thrown", () => {
  const ctx = ctxFor(fixture({ "docker-compose.yml": "services: [\n" }));
  assert.deepEqual(detectCompose(ctx), []);
  assert.equal(ctx.skipped.length, 1);
  assert.equal(ctx.skipped[0].item, "docker-compose.yml");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-compose.test.mjs`
Expected: FAIL (`detectCompose` is not exported).

- [ ] **Step 3: Write `compose.ts`**

```ts
/** docker-compose files → per-service environment, depends_on, command, port and health path. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readText } from "./files.js";
import { stated, type DetectContext, type Finding } from "./types.js";

export const COMPOSE_FILE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/;

/** The container side of a compose port spec. */
export function containerPort(spec: unknown): number | undefined {
  if (typeof spec === "number") return Number.isInteger(spec) && spec > 0 ? spec : undefined;
  if (typeof spec === "string") {
    const last = (spec.split(":").pop() ?? "").split("/")[0].split("-")[0];
    const n = Number(last);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  if (spec && typeof spec === "object") {
    const target = (spec as Record<string, unknown>).target;
    return typeof target === "number" && Number.isInteger(target) ? target : undefined;
  }
  return undefined;
}

function envMap(env: unknown): Record<string, string> {
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map(String).filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
    );
  }
  if (env && typeof env === "object") {
    return Object.fromEntries(
      Object.entries(env as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
  }
  return {};
}

function healthPath(hc: unknown): string | undefined {
  const t = (hc as Record<string, unknown> | undefined)?.test;
  const text = Array.isArray(t) ? t.join(" ") : String(t ?? "");
  return /https?:\/\/[^/\s"']+(\/[^\s"']*)/.exec(text)?.[1];
}

export function detectCompose(ctx: DetectContext): Finding[] {
  const out: Finding[] = [];
  for (const file of ctx.files.filter((f) => COMPOSE_FILE.test(f))) {
    let doc: any;
    try {
      doc = parseYaml(readText(ctx, file));
    } catch (e) {
      ctx.skipped.push({ item: file, reason: `unparsable YAML: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    for (const [name, raw] of Object.entries(doc?.services ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, any>;
      const src = (field: string) => `${file} → services.${name}.${field}`;
      const context = typeof s.build === "string" ? s.build : s.build?.context;
      const dir =
        context === undefined
          ? null
          : path.posix.normalize(path.posix.join(path.posix.dirname(file), String(context))).replace(/\/$/, "") || ".";
      const fields: Finding["fields"] = {};

      const env = envMap(s.environment);
      if (Object.keys(env).length) fields.environment = stated(env, src("environment"));
      const deps = Array.isArray(s.depends_on)
        ? s.depends_on.map(String)
        : s.depends_on && typeof s.depends_on === "object"
          ? Object.keys(s.depends_on)
          : [];
      if (deps.length) fields.depends_on = stated([...deps].sort(), src("depends_on"));
      if (s.command !== undefined) {
        fields.command = stated(Array.isArray(s.command) ? s.command.join(" ") : String(s.command), src("command"));
      }
      const port = containerPort(s.ports?.[0]) ?? containerPort(s.expose?.[0]);
      if (port) fields.internal_port = stated(port, src(s.ports ? "ports" : "expose"));
      const health = healthPath(s.healthcheck);
      if (health) fields.health_endpoint = stated(health, src("healthcheck"));

      out.push({ kind: "compose", name, dir, file, ...(s.image ? { image: String(s.image) } : {}), fields });
    }
  }
  return out;
}
```

- [ ] **Step 4: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./compose.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-compose.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/compose.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-compose.test.mjs
git commit -m "feat(detect): docker-compose detector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: k8s manifests, Helm and kustomize

**Files:**
- Create: `packages/sandbox-core/fragment_detect/k8s.ts`
- Create: `packages/sandbox-core/fragment_detect/helm.ts`
- Create: `packages/sandbox-core/fragment_detect/kustomize.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-k8s.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`DetectContext`, `Finding`, `stated`, `readText`, `yamlDocs`, `stdoutRunner`) and Task 4 (`COMPOSE_FILE`).
- Produces:
  - `ManifestSource = { file: string; dir: string | null; docs: unknown[] }`
  - `findingsFromManifests(sources: ManifestSource[]): Finding[]`. Services and Ingresses are pooled across `sources`, so a Service in another file still matches its Deployment.
  - `chartDirs(files: string[]): string[]`
  - `detectK8s(ctx): Finding[]`, `detectHelm(ctx): Finding[]`, `detectKustomize(ctx): Finding[]`
  - k8s findings have `kind: "k8s"`, `image`, and fields `k8s_namespace`, `k8s_pod_prefix`, `k8s_deployment?`, `internal_port?`, `health_endpoint?`, `memory_limit?`, `memory_reservation?`, `environment?`, `secrets?`, `k8s_port?`, `k8s_port_name?`, `feature_router?` (all stated).

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-k8s.test.mjs`:

```js
// Raw manifests, `helm template` output and `kubectl kustomize` output all go
// through the same k8s reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectHelm, detectK8s, detectKustomize, stdoutRunner } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

const DEMO_BACKEND = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  selector: { matchLabels: { app: backend } }
  template:
    metadata:
      labels: { app: backend }
    spec:
      containers:
        - name: backend
          image: backend:local
          ports:
            - containerPort: 3000
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
          resources:
            limits: { memory: 1Gi }
            requests: { memory: 256Mi }
          env:
            - name: DATABASE_URL
              value: postgres://postgres:postgres@postgres:5432/postgres
            - name: API_KEY
              valueFrom: { secretKeyRef: { name: api, key: key } }
---
apiVersion: v1
kind: Service
metadata:
  name: backend
spec:
  selector: { app: backend }
  ports:
    - port: 80
      name: http
      targetPort: 3000
`;

test("a raw Deployment + Service file", () => {
  const ctx = ctxFor(fixture({ "apps/backend/k8s.yaml": DEMO_BACKEND }));
  const [f] = detectK8s(ctx);
  assert.equal(f.name, "backend");
  assert.equal(f.dir, "apps/backend");
  assert.equal(f.image, "backend:local");
  const v = (k) => f.fields[k]?.value;
  assert.equal(v("internal_port"), 3000);
  assert.equal(v("health_endpoint"), "/health");
  assert.equal(v("k8s_deployment"), "backend");
  assert.equal(v("k8s_namespace"), "default");
  assert.equal(v("k8s_pod_prefix"), "backend");
  assert.equal(v("k8s_port"), 80);
  assert.equal(v("k8s_port_name"), "http");
  assert.equal(v("memory_limit"), "1G");
  assert.equal(v("memory_reservation"), "256M");
  assert.deepEqual(v("environment"), { DATABASE_URL: "postgres://postgres:postgres@postgres:5432/postgres" });
  assert.deepEqual(v("secrets"), ["API_KEY"]);
  assert.match(f.fields.internal_port.source, /apps\/backend\/k8s\.yaml → containerPort/);
});

test("a Service in a different file still matches its Deployment; an Ingress marks it routed", () => {
  const [deploy, svc] = DEMO_BACKEND.split("---");
  const ingress = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web }
spec:
  rules:
    - http:
        paths:
          - path: /
            backend: { service: { name: backend, port: { number: 80 } } }
`;
  const ctx = ctxFor(fixture({ "deploy/deployment.yaml": deploy, "deploy/service.yaml": svc, "deploy/ingress.yaml": ingress }));
  const [f] = detectK8s(ctx);
  assert.equal(f.fields.k8s_port.value, 80);
  assert.deepEqual(f.fields.feature_router.value, {});
});

test("a bare Deployment, a List, and YAML that isn't k8s", () => {
  const bare = "kind: Deployment\nmetadata: { name: lone }\nspec: { template: { spec: { containers: [ { name: c, image: x } ] } } }\n";
  const list = "kind: List\nitems:\n  - kind: StatefulSet\n    metadata: { name: db, namespace: data }\n    spec: { template: { spec: { containers: [ { name: c, image: postgres:16 } ] } } }\n";
  const ctx = ctxFor(fixture({ "a.yaml": bare, "b.yaml": list, ".github/x.yml": "kind: Deployment", "ci.yml": "on: push\n" }));
  const found = detectK8s(ctx);
  assert.deepEqual(found.map((f) => f.name), ["lone", "db"]);
  assert.equal(found[0].fields.internal_port, undefined);
  assert.equal(found[0].fields.health_endpoint, undefined);
  assert.equal(found[1].fields.k8s_namespace.value, "data");
  assert.equal(found[1].fields.k8s_deployment, undefined);
  assert.deepEqual(ctx.skipped, []);
});

test("a manifest that doesn't parse is skipped with its error", () => {
  const ctx = ctxFor(fixture({ "bad.yaml": "kind: Deployment\nmetadata: [\n" }));
  assert.deepEqual(detectK8s(ctx), []);
  assert.equal(ctx.skipped[0].item, "bad.yaml");
});

test("chart sources, values files and compose files are not read as raw manifests", () => {
  const ctx = ctxFor(fixture({
    "charts/webapp/Chart.yaml": "name: webapp\n",
    "charts/webapp/templates/deployment.yaml": "kind: Deployment\nmetadata: { name: {{ .Release.Name }} }\n",
    "charts/backend.values.yaml": "kind: Deployment\n",
    "docker-compose.yml": "kind: Deployment\n",
  }));
  assert.deepEqual(detectK8s(ctx), []);
  assert.deepEqual(ctx.skipped, []);
});

test("helm: each <release>.values.yaml next to a chart is rendered and read", () => {
  const root = fixture({
    "charts/webapp/Chart.yaml": "name: webapp\n",
    "charts/webapp/values.yaml": "containerPort: 3000\n",
    "charts/backend.values.yaml": "image: backend:local\n",
  });
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "helm") return [0, DEMO_BACKEND];
    return [128, "not a git repo"];
  };
  const ctx = ctxFor(root, runner);
  const [f] = detectHelm(ctx);
  assert.deepEqual(calls.filter((c) => c[0] === "helm"), [[
    "helm", "template", "backend", path.join(root, "charts/webapp"), "-f", path.join(root, "charts/backend.values.yaml"),
  ]]);
  assert.equal(f.name, "backend");
  assert.equal(f.dir, null);
  assert.match(f.fields.internal_port.source, /charts\/backend\.values\.yaml \(helm template\) → containerPort/);
});

test("helm: a chart with no sibling values files renders once under its Chart.yaml name", () => {
  const root = fixture({ "deploy/chart/Chart.yaml": "name: shop\n" });
  const seen = [];
  const ctx = ctxFor(root, (cmd) => (cmd[0] === "helm" ? (seen.push(cmd[2]), [0, ""]) : [128, ""]));
  detectHelm(ctx);
  assert.deepEqual(seen, ["shop"]);
});

test("helm missing: one skipped entry and no findings", () => {
  const root = fixture({
    "charts/webapp/Chart.yaml": "name: webapp\n",
    "charts/a.values.yaml": "",
    "charts/b.values.yaml": "",
  });
  const ctx = ctxFor(root);
  assert.deepEqual(detectHelm(ctx), []);
  assert.deepEqual(ctx.skipped, [{ item: "helm charts", reason: "helm is not installed — charts skipped" }]);
});

test("helm render failure is skipped per values file", () => {
  const root = fixture({ "charts/webapp/Chart.yaml": "name: webapp\n", "charts/a.values.yaml": "" });
  const ctx = ctxFor(root, (cmd) => (cmd[0] === "helm" ? [1, "Error: image is required\nmore"] : [128, ""]));
  assert.deepEqual(detectHelm(ctx), []);
  assert.deepEqual(ctx.skipped, [{ item: "charts/a.values.yaml", reason: "helm template failed: Error: image is required" }]);
});

test("kustomize: each kustomization dir is rendered with kubectl", () => {
  const root = fixture({ "deploy/overlays/dev/kustomization.yaml": "resources: []\n" });
  const ctx = ctxFor(root, (cmd) => (cmd[0] === "kubectl" ? [0, DEMO_BACKEND] : [128, ""]));
  const [f] = detectKustomize(ctx);
  assert.equal(f.name, "backend");
  assert.match(f.file, /deploy\/overlays\/dev\/kustomization\.yaml \(kubectl kustomize\)/);
});

test("real helm renders a real chart the same way (skipped without helm)", (t) => {
  if (stdoutRunner(["helm", "version"])[0] !== 0) return t.skip("helm not installed");
  const root = path.join(mkdtempSync(path.join(tmpdir(), "fd-helm-")), "repo");
  const write = (rel, body) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  write("charts/webapp/Chart.yaml", "apiVersion: v2\nname: webapp\nversion: 0.1.0\n");
  write("charts/webapp/values.yaml", "containerPort: 3000\nprobePath: /\n");
  write("charts/webapp/templates/deployment.yaml", [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata: { name: {{ .Release.Name }} }",
    "spec:",
    "  selector: { matchLabels: { app: {{ .Release.Name }} } }",
    "  template:",
    "    metadata: { labels: { app: {{ .Release.Name }} } }",
    "    spec:",
    "      containers:",
    "        - name: app",
    "          image: {{ .Values.image }}",
    "          ports: [ { containerPort: {{ .Values.containerPort }} } ]",
    "          readinessProbe: { httpGet: { path: {{ .Values.probePath }}, port: {{ .Values.containerPort }} } }",
    "",
  ].join("\n"));
  write("charts/api.values.yaml", "image: api:local\ncontainerPort: 4000\nprobePath: /health\n");
  const [f] = detectHelm(ctxFor(root, stdoutRunner));
  assert.equal(f.name, "api");
  assert.equal(f.fields.internal_port.value, 4000);
  assert.equal(f.fields.health_endpoint.value, "/health");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-k8s.test.mjs`
Expected: FAIL (`detectK8s` is not exported).

- [ ] **Step 3: Write `k8s.ts`**

```ts
/**
 * Kubernetes manifests → per-workload findings. Raw files, `helm template`
 * output and `kubectl kustomize` output all come through findingsFromManifests.
 */
import * as path from "node:path";

import { COMPOSE_FILE } from "./compose.js";
import { readText, yamlDocs } from "./files.js";
import { stated, type DetectContext, type Finding } from "./types.js";

export interface ManifestSource {
  /** Repo-relative file, or a label such as `x.values.yaml (helm template)`. */
  file: string;
  /** Directory used for location matching; null for rendered output. */
  dir: string | null;
  docs: unknown[];
}

const WORKLOADS = new Set(["Deployment", "StatefulSet"]);

/** `512Mi` → `512M`, `1Gi` → `1G`; anything compose can't read is dropped. */
function memory(v: unknown): string | undefined {
  const m = /^(\d+)([KMG])?i?$/.exec(String(v ?? ""));
  return m ? `${m[1]}${m[2] ?? ""}` : undefined;
}

function ingressBackends(ing: any): string[] {
  const rules: any[] = ing?.spec?.rules ?? [];
  return [
    ing?.spec?.defaultBackend?.service?.name,
    ...rules.flatMap((r) => (r?.http?.paths ?? []).map((p: any) => p?.backend?.service?.name)),
  ].filter((n): n is string => typeof n === "string");
}

export function findingsFromManifests(sources: ManifestSource[]): Finding[] {
  const items = sources.flatMap((s) =>
    s.docs
      .flatMap((d: any) => (d?.kind === "List" && Array.isArray(d.items) ? d.items : [d]))
      .filter((d: any) => d && typeof d === "object" && typeof d.kind === "string")
      .map((doc: any) => ({ doc, source: s })),
  );
  const services = items.filter((i) => i.doc.kind === "Service").map((i) => i.doc);
  const routed = new Set(items.filter((i) => i.doc.kind === "Ingress").flatMap((i) => ingressBackends(i.doc)));

  const out: Finding[] = [];
  for (const { doc: w, source } of items.filter((i) => WORKLOADS.has(i.doc.kind))) {
    const name = w.metadata?.name;
    const c = w.spec?.template?.spec?.containers?.[0];
    if (typeof name !== "string" || !c) continue;
    const src = (field: string) => `${source.file} → ${field}`;
    const fields: Finding["fields"] = {
      k8s_namespace: w.metadata?.namespace
        ? stated(w.metadata.namespace, src("metadata.namespace"))
        : stated("default", `${source.file} → no metadata.namespace (Kubernetes default)`),
      k8s_pod_prefix: stated(name, src(`${w.kind} ${name}`)),
    };
    if (w.kind === "Deployment") fields.k8s_deployment = stated(name, src(`Deployment ${name}`));

    const port = c.ports?.[0]?.containerPort;
    if (Number.isInteger(port)) fields.internal_port = stated(port, src("containerPort"));
    const probe = c.readinessProbe?.httpGet?.path
      ? (["readinessProbe", c.readinessProbe.httpGet.path] as const)
      : c.livenessProbe?.httpGet?.path
        ? (["livenessProbe", c.livenessProbe.httpGet.path] as const)
        : null;
    if (probe) fields.health_endpoint = stated(String(probe[1]), src(`${probe[0]}.httpGet.path`));

    const limit = memory(c.resources?.limits?.memory);
    const request = memory(c.resources?.requests?.memory);
    if (limit) fields.memory_limit = stated(limit, src("resources.limits.memory"));
    if (request) fields.memory_reservation = stated(request, src("resources.requests.memory"));

    const env: Record<string, string> = {};
    const secrets: string[] = [];
    for (const e of Array.isArray(c.env) ? c.env : []) {
      if (typeof e?.name !== "string") continue;
      if (e.valueFrom?.secretKeyRef) secrets.push(e.name);
      else if (e.value !== undefined && e.value !== null) env[e.name] = String(e.value);
    }
    if (Object.keys(env).length) fields.environment = stated(env, src("env"));
    if (secrets.length) fields.secrets = stated([...secrets].sort(), src("env[].valueFrom.secretKeyRef"));

    const labels: Record<string, string> = w.spec?.template?.metadata?.labels ?? {};
    const svc = services.find((s: any) => {
      const sel: Record<string, string> = s.spec?.selector ?? {};
      return Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
    });
    const svcName: string | undefined = svc?.metadata?.name;
    const sp = svc?.spec?.ports?.[0];
    if (Number.isInteger(sp?.port)) fields.k8s_port = stated(sp.port, src(`Service ${svcName} port`));
    if (typeof sp?.name === "string") fields.k8s_port_name = stated(sp.name, src(`Service ${svcName} port name`));
    if (svcName && routed.has(svcName)) fields.feature_router = stated({}, src(`Ingress → Service ${svcName}`));

    out.push({
      kind: "k8s",
      name,
      dir: source.dir,
      file: source.file,
      ...(typeof c.image === "string" ? { image: c.image } : {}),
      fields,
    });
  }
  return out;
}

/** Every directory holding a Chart.yaml. */
export function chartDirs(files: string[]): string[] {
  return files.filter((f) => path.posix.basename(f) === "Chart.yaml").map((f) => path.posix.dirname(f));
}

const NOT_RAW = [
  /(^|\/)values[^/]*\.ya?ml$/,
  /\.values\.ya?ml$/,
  /(^|\/)kustomization\.ya?ml$/,
  /^pnpm-workspace\.yaml$/,
  COMPOSE_FILE,
];
/** Cheap pre-filter, so YAML that isn't k8s is never parsed or reported. */
const K8S_KIND = /^\s*kind:\s*(Deployment|StatefulSet|Service|Ingress|List)\b/m;

/** Raw manifests in the repo. Chart sources are left to detectHelm. */
export function detectK8s(ctx: DetectContext): Finding[] {
  const charts = chartDirs(ctx.files);
  const inChart = (f: string) => charts.some((c) => c === "." || f.startsWith(`${c}/`));
  const sources: ManifestSource[] = [];
  for (const file of ctx.files) {
    if (!/\.ya?ml$/.test(file) || inChart(file) || NOT_RAW.some((r) => r.test(file))) continue;
    const text = readText(ctx, file);
    if (!K8S_KIND.test(text)) continue;
    try {
      sources.push({ file, dir: path.posix.dirname(file), docs: yamlDocs(text) });
    } catch (e) {
      ctx.skipped.push({ item: file, reason: `unparsable YAML: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return findingsFromManifests(sources);
}
```

- [ ] **Step 4: Write `helm.ts`**

```ts
/** Helm charts → `helm template` output → findingsFromManifests. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readText, yamlDocs } from "./files.js";
import { chartDirs, findingsFromManifests } from "./k8s.js";
import type { DetectContext, Finding } from "./types.js";

function chartName(ctx: DetectContext, chart: string): string {
  try {
    const name = parseYaml(readText(ctx, `${chart}/Chart.yaml`))?.name;
    return typeof name === "string" && name ? name : path.posix.basename(chart);
  } catch {
    return path.posix.basename(chart);
  }
}

/**
 * Each `<release>.values.yaml` beside a chart is one release of it
 * (`charts/backend.values.yaml` + `charts/webapp`); a chart with none renders
 * once with its own values under its Chart.yaml name.
 */
export function detectHelm(ctx: DetectContext): Finding[] {
  const charts = chartDirs(ctx.files);
  const out: Finding[] = [];
  for (const chart of charts) {
    const parent = path.posix.dirname(chart);
    const siblings = charts.filter((c) => path.posix.dirname(c) === parent);
    const valuesHere = ctx.files.filter((f) => path.posix.dirname(f) === parent && /[^/]\.values\.ya?ml$/.test(f));
    if (valuesHere.length && siblings.length > 1) {
      if (chart === siblings[0]) {
        for (const v of valuesHere) {
          ctx.skipped.push({ item: v, reason: `several charts in ${parent}/ — can't tell which one ${v} is for` });
        }
      }
      continue;
    }
    const releases = valuesHere.length
      ? valuesHere.map((v) => ({ release: path.posix.basename(v).replace(/\.values\.ya?ml$/, ""), values: v as string | null }))
      : [{ release: chartName(ctx, chart), values: null }];
    for (const { release, values } of releases) {
      const cmd = ["helm", "template", release, path.join(ctx.root, chart)];
      if (values) cmd.push("-f", path.join(ctx.root, values));
      const [rc, text] = ctx.runner(cmd);
      if (rc === 127) {
        ctx.skipped.push({ item: "helm charts", reason: "helm is not installed — charts skipped" });
        return out;
      }
      const item = values ?? chart;
      if (rc !== 0) {
        ctx.skipped.push({ item, reason: `helm template failed: ${text.split("\n")[0]}` });
        continue;
      }
      try {
        out.push(...findingsFromManifests([{ file: `${item} (helm template)`, dir: null, docs: yamlDocs(text) }]));
      } catch (e) {
        ctx.skipped.push({ item, reason: `unparsable helm output: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Write `kustomize.ts`**

```ts
/** kustomize overlays → `kubectl kustomize` output → findingsFromManifests. */
import * as path from "node:path";

import { yamlDocs } from "./files.js";
import { findingsFromManifests } from "./k8s.js";
import type { DetectContext, Finding } from "./types.js";

export function detectKustomize(ctx: DetectContext): Finding[] {
  const out: Finding[] = [];
  for (const file of ctx.files.filter((f) => /(^|\/)kustomization\.ya?ml$/.test(f))) {
    const dir = path.posix.dirname(file);
    const [rc, text] = ctx.runner(["kubectl", "kustomize", path.join(ctx.root, dir)]);
    if (rc === 127) {
      ctx.skipped.push({ item: "kustomize overlays", reason: "kubectl is not installed — overlays skipped" });
      return out;
    }
    if (rc !== 0) {
      ctx.skipped.push({ item: file, reason: `kubectl kustomize failed: ${text.split("\n")[0]}` });
      continue;
    }
    try {
      out.push(...findingsFromManifests([{ file: `${file} (kubectl kustomize)`, dir: null, docs: yamlDocs(text) }]));
    } catch (e) {
      ctx.skipped.push({ item: file, reason: `unparsable kustomize output: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}
```

- [ ] **Step 6: Export them**

Append to `fragment_detect/index.ts`:

```ts
export * from "./k8s.js";
export * from "./helm.js";
export * from "./kustomize.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-k8s.test.mjs`
Expected: PASS, 11 tests. The last one passes here because `helm` is installed; it reports as skipped where it isn't.

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox-core/fragment_detect/k8s.ts packages/sandbox-core/fragment_detect/helm.ts \
  packages/sandbox-core/fragment_detect/kustomize.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-k8s.test.mjs
git commit -m "feat(detect): k8s manifest, Helm and kustomize detectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Correlation

**Files:**
- Create: `packages/sandbox-core/fragment_detect/correlate.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-correlate.test.mjs`

**Interfaces:**
- Consumes (Task 1): `Finding`, `Skipped`.
- Produces:
  - `DATASTORES: Record<string, { health: string; port: number }>`
  - `imageRepoName(image: string): string`
  - `ServiceGroup = { name: string; dir: string; findings: Finding[] }`
  - `InfraGroup = { name: string; datastore: string; findings: Finding[] }`
  - `Correlation = { services: ServiceGroup[]; infrastructure: InfraGroup[]; unmatched: Finding[]; skipped: Skipped[] }`
  - `correlate(findings: Finding[], repoName: string): Correlation`

One clarification of spec §2: a finding whose image is a known datastore can only match a service by name (rule 3), never by location (rule 1) or image (rule 4). Without this, `apps/api/k8s/redis.yaml` would attach redis to `api`.

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-correlate.test.mjs`:

```js
// Findings from every detector grouped into services, infrastructure and leftovers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { correlate, imageRepoName } from "./dist/fragment_detect/index.js";

const f = (kind, name, dir, extra = {}) => ({ kind, name, dir, file: `${dir ?? "x"}/${kind}`, fields: {}, ...extra });
const pkg = (dir, runnable = true) => f("package", dir.split("/").pop(), dir, { runnable });

test("imageRepoName strips registry, org, tag and digest", () => {
  assert.equal(imageRepoName("ghcr.io/acme/backend:1.2@sha256:abc"), "backend");
  assert.equal(imageRepoName("postgres:16"), "postgres");
  assert.equal(imageRepoName("bitnami/redis"), "redis");
});

test("anchors are source dirs; the four matching rules in order", () => {
  const c = correlate(
    [
      pkg("apps/backend"),
      pkg("apps/frontend"),
      f("dockerfile", "worker", "services/worker"),
      f("k8s", "something-else", "apps/backend/deploy"), // rule 1: inside the anchor dir
      f("compose", "fe", "apps/frontend"), // rule 2: build context
      f("k8s", "worker", null), // rule 3: name
      f("k8s", "web", null, { image: "ghcr.io/acme/frontend:1" }), // rule 4: image
    ],
    "demo",
  );
  const byName = Object.fromEntries(c.services.map((s) => [s.name, s.findings.map((x) => x.name)]));
  assert.deepEqual(byName, {
    backend: ["backend", "something-else"],
    frontend: ["frontend", "fe", "web"],
    worker: ["worker", "worker"],
  });
});

test("a single-service repo anchors at . and is named after the repo; location rule doesn't apply to .", () => {
  const c = correlate([pkg("."), f("k8s", "redis", "charts", { image: "redis:7" }), f("k8s", "shop", null)], "shop");
  assert.deepEqual(c.services.map((s) => [s.name, s.dir, s.findings.length]), [["shop", ".", 2]]);
  assert.deepEqual(c.infrastructure.map((i) => [i.name, i.datastore]), [["redis", "redis"]]);
});

test("colliding basenames become <parent>-<basename>; a root parent uses the repo name", () => {
  const c = correlate([pkg("services/api"), pkg("tools/api"), pkg("api")], "acme");
  assert.deepEqual(c.services.map((s) => s.name).sort(), ["acme-api", "services-api", "tools-api"]);
});

test("datastores become infrastructure, merged across k8s and compose by name", () => {
  const c = correlate(
    [pkg("apps/api"), f("k8s", "redis", "apps/api/k8s", { image: "redis:7-alpine" }), f("compose", "redis", null, { image: "redis:7" })],
    "r",
  );
  assert.deepEqual(c.services[0].findings.map((x) => x.kind), ["package"]);
  assert.equal(c.infrastructure.length, 1);
  assert.equal(c.infrastructure[0].findings.length, 2);
});

test("an unmatched app Deployment is skipped and reported", () => {
  const c = correlate([pkg("apps/api"), f("k8s", "payments", null, { image: "payments:1" })], "r");
  assert.equal(c.unmatched.length, 1);
  assert.match(c.skipped[0].reason, /found Deployment payments — no source dir in this repo, skipped/);
});

test("a library package with nothing else is skipped; a runnable one or one with deploy config is kept", () => {
  const c = correlate([pkg("packages/utils", false), pkg("packages/ui", false), f("k8s", "ui", null)], "r");
  assert.deepEqual(c.services.map((s) => s.name), ["ui"]);
  assert.deepEqual(c.skipped, [{
    item: "packages/utils",
    reason: "library package (no Dockerfile, deploy config or dev/start script), skipped",
  }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-correlate.test.mjs`
Expected: FAIL (`correlate` is not exported).

- [ ] **Step 3: Write `correlate.ts`**

```ts
/** Group findings into services (anchored to a source dir), infrastructure and leftovers. */
import * as path from "node:path";

import type { Finding, Skipped } from "./types.js";

/** Known datastore images → the wire probe `sandbox` can run (`""` = TCP only) and their default port. */
export const DATASTORES: Record<string, { health: string; port: number }> = {
  redis: { health: "redis", port: 6379 },
  postgres: { health: "postgres", port: 5432 },
  postgis: { health: "postgres", port: 5432 },
  mysql: { health: "", port: 3306 },
  mariadb: { health: "", port: 3306 },
  mongo: { health: "", port: 27017 },
  rabbitmq: { health: "", port: 5672 },
};

/** `ghcr.io/acme/backend:1.2@sha256:…` → `backend`. */
export function imageRepoName(image: string): string {
  const last = image.split("@")[0].split("/").pop() ?? image;
  return last.split(":")[0];
}

export interface ServiceGroup {
  name: string;
  dir: string;
  findings: Finding[];
}

export interface InfraGroup {
  name: string;
  datastore: string;
  findings: Finding[];
}

export interface Correlation {
  services: ServiceGroup[];
  infrastructure: InfraGroup[];
  /** Deploy-side findings that matched nothing and aren't datastores. */
  unmatched: Finding[];
  skipped: Skipped[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function datastoreOf(f: Finding): string | null {
  const repo = f.image ? imageRepoName(f.image) : "";
  return Object.hasOwn(DATASTORES, repo) ? repo : null;
}

export function correlate(findings: Finding[], repoName: string): Correlation {
  const sourceSide = findings.filter((f) => f.kind === "package" || f.kind === "dockerfile");
  const deploySide = findings.filter((f) => f.kind === "k8s" || f.kind === "compose");

  const dirs = [...new Set(sourceSide.map((f) => f.dir as string))].sort();
  const base = (d: string) => (d === "." ? repoName : path.posix.basename(d));
  const parent = (d: string) => {
    const p = path.posix.dirname(d);
    return p === "." ? repoName : path.posix.basename(p);
  };
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(base(d), (counts.get(base(d)) ?? 0) + 1);
  const groups: ServiceGroup[] = dirs.map((d) => ({
    dir: d,
    name: (counts.get(base(d)) ?? 0) > 1 ? `${parent(d)}-${base(d)}` : base(d),
    findings: sourceSide.filter((f) => f.dir === d),
  }));

  type Rule = (f: Finding, g: ServiceGroup) => boolean;
  const rules: Rule[] = [
    (f, g) => f.kind === "k8s" && f.dir !== null && g.dir !== "." && (f.dir === g.dir || f.dir.startsWith(`${g.dir}/`)),
    (f, g) => f.kind === "compose" && f.dir !== null && f.dir === g.dir,
    (f, g) => f.name === g.name,
    (f, g) => Boolean(f.image) && imageRepoName(f.image as string) === g.name,
  ];
  const leftover: Finding[] = [];
  for (const f of deploySide) {
    // A datastore can only be claimed by name; location and image would mis-attach it.
    const usable = datastoreOf(f) ? [rules[2]] : rules;
    let target: ServiceGroup | undefined;
    for (const rule of usable) {
      target = groups.find((g) => rule(f, g));
      if (target) break;
    }
    if (target) target.findings.push(f);
    else leftover.push(f);
  }

  const skipped: Skipped[] = [];
  const infra = new Map<string, InfraGroup>();
  const unmatched: Finding[] = [];
  for (const f of leftover) {
    const ds = datastoreOf(f);
    if (ds) {
      const g = infra.get(f.name) ?? { name: f.name, datastore: ds, findings: [] };
      g.findings.push(f);
      infra.set(f.name, g);
    } else {
      unmatched.push(f);
      const what = f.kind === "k8s" ? "Deployment" : "compose service";
      skipped.push({ item: f.file, reason: `found ${what} ${f.name} — no source dir in this repo, skipped` });
    }
  }

  const services = groups.filter((g) => {
    const keep = g.findings.some((f) => f.kind !== "package" || f.runnable);
    if (!keep) {
      skipped.push({ item: g.dir, reason: "library package (no Dockerfile, deploy config or dev/start script), skipped" });
    }
    return keep;
  });

  return { services: services.sort(byName), infrastructure: [...infra.values()].sort(byName), unmatched, skipped };
}
```

- [ ] **Step 4: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./correlate.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-correlate.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/correlate.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-correlate.test.mjs
git commit -m "feat(detect): correlate findings into services and infrastructure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Precedence

**Files:**
- Create: `packages/sandbox-core/fragment_detect/precedence.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-precedence.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`FieldValue`, `Finding`, `FindingKind`, `stated`, `guessed`) and Task 6 (`ServiceGroup`, `InfraGroup`, `DATASTORES`).
- Produces:
  - `Conflict = { service: string; key: string; chosen: FieldValue; also: FieldValue[] }`
  - `ResolvedService = { name: string; dir: string; fields: Record<string, FieldValue>; conflicts: Conflict[]; k8sEnvKeys: string[]; findings: Finding[] }`
  - `ResolvedInfra = { name: string; fields: Record<string, FieldValue> }`
  - `resolveService(group: ServiceGroup): ResolvedService`
  - `resolveInfra(group: InfraGroup): ResolvedInfra`

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-precedence.test.mjs`:

```js
// One value per field from a group's findings, in the spec's order (§3).
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveInfra, resolveService } from "./dist/fragment_detect/index.js";

const st = (value, source) => ({ value, source, confidence: "stated" });
const gu = (value, source) => ({ value, source, confidence: "guessed" });
const finding = (kind, fields, extra = {}) => ({ kind, name: "api", dir: null, file: kind, fields, ...extra });

test("k8s port beats EXPOSE, and the disagreement is recorded", () => {
  const r = resolveService({
    name: "api",
    dir: "apps/api",
    findings: [
      finding("dockerfile", { internal_port: st(8080, "Dockerfile → EXPOSE"), image: st("node:22", "Dockerfile → FROM") }),
      finding("k8s", { internal_port: st(3000, "k8s.yaml → containerPort") }),
    ],
  });
  assert.equal(r.fields.internal_port.value, 3000);
  assert.equal(r.fields.path.value, "apps/api");
  assert.deepEqual(r.conflicts, [{
    service: "api",
    key: "internal_port",
    chosen: st(3000, "k8s.yaml → containerPort"),
    also: [st(8080, "Dockerfile → EXPOSE")],
  }]);
});

test("a stated value beats a guess without recording a conflict", () => {
  const r = resolveService({
    name: "api",
    dir: ".",
    findings: [
      finding("package", { command: st("exec npm run dev", "package.json"), image: gu("node:22-alpine", "no Dockerfile") }),
      finding("dockerfile", { command: gu("node server.js", "CMD"), image: st("node:22", "FROM") }),
    ],
  });
  assert.equal(r.fields.command.value, "exec npm run dev");
  assert.equal(r.fields.image.value, "node:22");
  assert.deepEqual(r.conflicts, []);
});

test("environment merges per key, compose winning; only k8s-only keys are rewrite candidates", () => {
  const r = resolveService({
    name: "api",
    dir: "apps/api",
    findings: [
      finding("k8s", { environment: st({ DB: "postgres:5432", MODE: "prod" }, "k8s.yaml → env") }),
      finding("compose", { environment: st({ MODE: "dev" }, "compose → environment") }),
    ],
  });
  assert.deepEqual(r.fields.environment.value, { DB: "postgres:5432", MODE: "dev" });
  assert.deepEqual(r.k8sEnvKeys, ["DB"]);
});

test("fallbacks are guesses: port 3000, TCP-only health, type api", () => {
  const r = resolveService({ name: "x", dir: "x", findings: [finding("dockerfile", {})] });
  assert.deepEqual(r.fields.internal_port, gu(3000, "no port in any source — default 3000"));
  assert.equal(r.fields.health_endpoint.value, "");
  assert.equal(r.fields.health_endpoint.confidence, "guessed");
  assert.equal(r.fields.type.value, "api");
  assert.equal(r.fields.image.confidence, "guessed");
});

test("feature_router: an Ingress states it, type web guesses it, an api gets none", () => {
  const web = resolveService({ name: "w", dir: "w", findings: [finding("package", { type: st("web", "next") })] });
  assert.deepEqual(web.fields.feature_router, gu({}, "type: web — routed through Caddy"));
  const ing = resolveService({ name: "a", dir: "a", findings: [finding("k8s", { feature_router: st({}, "Ingress") })] });
  assert.equal(ing.fields.feature_router.confidence, "stated");
  const api = resolveService({ name: "a", dir: "a", findings: [finding("package", { type: st("api", "express") })] });
  assert.equal(api.fields.feature_router, undefined);
});

test("infrastructure from k8s, and from compose alone", () => {
  const k8s = resolveInfra({
    name: "postgres",
    datastore: "postgres",
    findings: [finding("k8s", {
      internal_port: st(5432, "pg.yaml → containerPort"),
      k8s_namespace: st("default", "pg.yaml"),
      k8s_pod_prefix: st("postgres", "pg.yaml"),
    })],
  });
  assert.deepEqual(Object.fromEntries(Object.entries(k8s.fields).map(([k, v]) => [k, v.value])), {
    internal_port: 5432, k8s_namespace: "default", k8s_pod_prefix: "postgres", health_endpoint: "postgres",
  });
  const compose = resolveInfra({ name: "cache", datastore: "redis", findings: [finding("compose", {})] });
  assert.equal(compose.fields.internal_port.value, 6379);
  assert.equal(compose.fields.k8s_pod_prefix.confidence, "guessed");
  assert.equal(compose.fields.health_endpoint.value, "redis");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-precedence.test.mjs`
Expected: FAIL (`resolveService` is not exported).

- [ ] **Step 3: Write `precedence.ts`**

```ts
/** One value per field from a correlated group, in the spec's precedence order (§3). */
import { DATASTORES, type InfraGroup, type ServiceGroup } from "./correlate.js";
import { guessed, stated, type FieldValue, type Finding, type FindingKind } from "./types.js";

export interface Conflict {
  service: string;
  key: string;
  chosen: FieldValue;
  also: FieldValue[];
}

export interface ResolvedService {
  name: string;
  dir: string;
  fields: Record<string, FieldValue>;
  conflicts: Conflict[];
  /** Environment keys that came from k8s alone: candidates for the tunnel rewrite. */
  k8sEnvKeys: string[];
  findings: Finding[];
}

export interface ResolvedInfra {
  name: string;
  fields: Record<string, FieldValue>;
}

/** Which detectors may supply each field, highest precedence first. `environment` is merged separately. */
const ORDER: Record<string, FindingKind[]> = {
  type: ["package"],
  archetype: ["package"],
  test: ["package"],
  internal_port: ["k8s", "compose", "dockerfile"],
  health_endpoint: ["k8s", "compose"],
  setup_service: ["package"],
  image: ["dockerfile", "package"],
  command: ["package", "compose", "dockerfile"],
  memory_limit: ["k8s"],
  memory_reservation: ["k8s"],
  node_modules_volume: ["package"],
  secrets: ["k8s"],
  k8s_deployment: ["k8s"],
  k8s_namespace: ["k8s"],
  k8s_port: ["k8s"],
  k8s_port_name: ["k8s"],
  k8s_pod_prefix: ["k8s"],
  feature_router: ["k8s"],
  depends_on: ["compose"],
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function envOf(findings: Finding[], kind: FindingKind): Record<string, string> {
  return Object.assign(
    {},
    ...findings.filter((f) => f.kind === kind && f.fields.environment).map((f) => f.fields.environment.value as Record<string, string>),
  );
}

export function resolveService(group: ServiceGroup): ResolvedService {
  const fields: Record<string, FieldValue> = { path: stated(group.dir, "source directory") };
  const conflicts: Conflict[] = [];
  for (const [key, kinds] of Object.entries(ORDER)) {
    const candidates = kinds.flatMap((k) =>
      group.findings.filter((f) => f.kind === k && f.fields[key] !== undefined).map((f) => f.fields[key]),
    );
    if (!candidates.length) continue;
    const chosen = candidates[0];
    fields[key] = chosen;
    if (chosen.confidence !== "stated") continue;
    const also = candidates
      .slice(1)
      .filter((c) => c.confidence === "stated" && !same(c.value, chosen.value))
      .filter((c, i, all) => all.findIndex((o) => same(o.value, c.value)) === i);
    if (also.length) conflicts.push({ service: group.name, key, chosen, also });
  }

  fields.internal_port ??= guessed(3000, "no port in any source — default 3000");
  fields.health_endpoint ??= guessed("", "no readiness probe or healthcheck — TCP-only");
  fields.type ??= guessed("api", "no package.json — assumed a service");
  fields.image ??= guessed("alpine:3", "no usable FROM and no package.json — set the dev image");
  if (!fields.feature_router && fields.type.value === "web") {
    fields.feature_router = guessed({}, "type: web — routed through Caddy");
  }

  const k8sEnv = envOf(group.findings, "k8s");
  const composeEnv = envOf(group.findings, "compose");
  const env = { ...k8sEnv, ...composeEnv };
  if (Object.keys(env).length) {
    const from = [Object.keys(composeEnv).length ? "compose environment" : "", Object.keys(k8sEnv).length ? "k8s env" : ""];
    fields.environment = stated(sortKeys(env), from.filter(Boolean).join(" + "));
  }
  const k8sEnvKeys = Object.keys(k8sEnv).filter((k) => !(k in composeEnv)).sort();

  return { name: group.name, dir: group.dir, fields, conflicts, k8sEnvKeys, findings: group.findings };
}

export function resolveInfra(group: InfraGroup): ResolvedInfra {
  const ds = DATASTORES[group.datastore];
  const k8s = group.findings.find((f) => f.kind === "k8s");
  const port = k8s?.fields.internal_port ?? group.findings.find((f) => f.fields.internal_port)?.fields.internal_port;
  const noManifest = "no k8s manifest for this datastore";
  return {
    name: group.name,
    fields: {
      internal_port: port ?? stated(ds.port, `${group.datastore} default port`),
      k8s_namespace: k8s?.fields.k8s_namespace ?? guessed("default", noManifest),
      k8s_pod_prefix: k8s?.fields.k8s_pod_prefix ?? guessed(group.name, noManifest),
      health_endpoint: stated(ds.health, ds.health ? `${group.datastore} wire probe` : "no wire probe for this datastore — TCP-only"),
    },
  };
}
```

- [ ] **Step 4: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./precedence.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-precedence.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/precedence.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-precedence.test.mjs
git commit -m "feat(detect): field precedence and conflict recording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Allocation and the environment rewrite

**Files:**
- Create: `packages/sandbox-core/fragment_detect/allocate.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-allocate.test.mjs`

**Interfaces:**
- Consumes: `discoverFragments` from `../registry_sync.js` (returns `{ repo, path, doc }[]` and throws `RegistryError` on an unparsable fragment), and `portsYamlPath` from `../config.js`.
- Produces:
  - `class AllocationError extends Error`
  - `Taken = { offsets: Set<number>; forwards: Set<number> }`
  - `portsPerSlot(file?: string): number`
  - `takenPorts(reposRoot: string, fragmentPath: string, localPath: string, existing: Record<string, any> | null): Taken`
  - `allocateOffsets(names: string[], taken: Set<number>, limit: number): Map<string, number>`
  - `allocateForwards(names: string[], taken: Set<number>, start?: number): Map<string, number>`
  - `rewriteEnv(env, keys, tunnels): { env: Record<string, string>; rewritten: string[] }`, where `tunnels` is `{ name: string; port: number; forward: number }[]`

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-allocate.test.mjs`:

```js
// Machine-wide port allocation and the in-cluster → tunnel env rewrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AllocationError, allocateForwards, allocateOffsets, portsPerSlot, rewriteEnv, takenPorts,
} from "./dist/fragment_detect/index.js";

test("offsets fill the lowest gap, in sorted name order", () => {
  const got = allocateOffsets(["zeta", "alpha", "mid"], new Set([0, 1, 2, 3, 4, 5, 7, 8]), 20);
  assert.deepEqual([...got], [["alpha", 6], ["mid", 9], ["zeta", 10]]);
});

test("running out of offsets throws with the spec's message", () => {
  const taken = new Set(Array.from({ length: 20 }, (_, i) => i));
  assert.throws(() => allocateOffsets(["x"], taken, 20), (e) =>
    e instanceof AllocationError &&
    e.message === "port_offset exhausted: 20 offsets (ports.yaml ports_per_slot) are all used — raise ports_per_slot or free one");
});

test("forward ports start at 9050 and skip taken ones", () => {
  assert.deepEqual([...allocateForwards(["redis", "postgres"], new Set([9050, 9052]))], [["postgres", 9051], ["redis", 9053]]);
});

test("takenPorts reads other repos' fragments, the local overlay and the existing file — not this repo's own path", () => {
  const reposRoot = mkdtempSync(path.join(tmpdir(), "fd-alloc-"));
  const write = (rel, body) => {
    mkdirSync(path.dirname(path.join(reposRoot, rel)), { recursive: true });
    writeFileSync(path.join(reposRoot, rel), body);
  };
  write("other/.sandbox/services.yaml", "services:\n  a: { port_offset: 0, k8s_forward_port: 9052 }\ninfrastructure:\n  redis: { k8s_forward_port: 9050, internal_port: 6379 }\n");
  write("mine/.sandbox/services.yaml", "services:\n  stale: { port_offset: 5 }\n");
  write("local.yaml", "services:\n  b: { port_offset: 3 }\n");
  const taken = takenPorts(reposRoot, path.join(reposRoot, "mine/.sandbox/services.yaml"), path.join(reposRoot, "local.yaml"), { services: { kept: { port_offset: 1 } } });
  assert.deepEqual([...taken.offsets].sort(), [0, 1, 3]);
  assert.deepEqual([...taken.forwards].sort(), [9050, 9052]);
});

test("portsPerSlot reads ports.yaml and defaults to 20", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fd-ports-"));
  writeFileSync(path.join(dir, "ports.yaml"), "feature_slots:\n  ports_per_slot: 30\n");
  assert.equal(portsPerSlot(path.join(dir, "ports.yaml")), 30);
  assert.equal(portsPerSlot(path.join(dir, "missing.yaml")), 20);
});

test("rewriteEnv points an in-cluster datastore address at the tunnel", () => {
  const env = {
    DATABASE_URL: "postgres://postgres:postgres@postgres:5432/postgres",
    OTHER: "my-postgres:5432",
    FROM_COMPOSE: "postgres:5432",
  };
  const r = rewriteEnv(env, ["DATABASE_URL", "OTHER"], [{ name: "postgres", port: 5432, forward: 9051 }]);
  assert.equal(r.env.DATABASE_URL, "postgres://postgres:postgres@k8s-postgres:9051/postgres");
  assert.equal(r.env.OTHER, "my-postgres:5432");
  assert.equal(r.env.FROM_COMPOSE, "postgres:5432");
  assert.deepEqual(r.rewritten, ["DATABASE_URL"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-allocate.test.mjs`
Expected: FAIL (`allocateOffsets` is not exported).

- [ ] **Step 3: Write `allocate.ts`**

```ts
/**
 * port_offset and k8s_forward_port allocation (spec §4), and the rewrite of
 * k8s env values that address infrastructure in-cluster.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { portsYamlPath } from "../config.js";
import { discoverFragments } from "../registry_sync.js";

export class AllocationError extends Error {}

export interface Taken {
  offsets: Set<number>;
  forwards: Set<number>;
}

/** `feature_slots.ports_per_slot` from ports.yaml; 20 when unreadable. */
export function portsPerSlot(file = portsYamlPath()): number {
  try {
    const n = parseYaml(fs.readFileSync(file, "utf8"))?.feature_slots?.ports_per_slot;
    return Number.isInteger(n) && n > 0 ? n : 20;
  } catch {
    return 20;
  }
}

function collect(doc: Record<string, any> | null, taken: Taken): void {
  for (const section of ["services", "infrastructure"]) {
    for (const entry of Object.values(doc?.[section] ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (Number.isInteger(e.port_offset)) taken.offsets.add(e.port_offset as number);
      if (Number.isInteger(e.k8s_forward_port)) taken.forwards.add(e.k8s_forward_port as number);
    }
  }
}

/**
 * Offsets and forward ports already claimed. Other repos' fragments are read
 * directly (not the generated registry), so a repo cloned but not yet synced
 * still counts. This repo's own fragment comes in as *existing*.
 */
export function takenPorts(
  reposRoot: string,
  fragmentPath: string,
  localPath: string,
  existing: Record<string, any> | null,
): Taken {
  const taken: Taken = { offsets: new Set(), forwards: new Set() };
  for (const f of discoverFragments(reposRoot)) {
    if (path.resolve(f.path) !== path.resolve(fragmentPath)) collect(f.doc, taken);
  }
  if (fs.existsSync(localPath)) collect(parseYaml(fs.readFileSync(localPath, "utf8")) ?? null, taken);
  collect(existing, taken);
  return taken;
}

export function allocateOffsets(names: string[], taken: Set<number>, limit: number): Map<string, number> {
  const used = new Set(taken);
  const out = new Map<string, number>();
  for (const name of [...names].sort()) {
    let n = 0;
    while (used.has(n)) n++;
    if (n >= limit) {
      throw new AllocationError(
        `port_offset exhausted: ${limit} offsets (ports.yaml ports_per_slot) are all used — raise ports_per_slot or free one`,
      );
    }
    used.add(n);
    out.set(name, n);
  }
  return out;
}

export function allocateForwards(names: string[], taken: Set<number>, start = 9050): Map<string, number> {
  const used = new Set(taken);
  const out = new Map<string, number>();
  for (const name of [...names].sort()) {
    let n = start;
    while (used.has(n)) n++;
    used.add(n);
    out.set(name, n);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `postgres:5432` (in-cluster) → `k8s-postgres:<forward>` (the sandbox
 * tunnel), in the *keys* that came from k8s only.
 */
export function rewriteEnv(
  env: Record<string, string>,
  keys: string[],
  tunnels: { name: string; port: number; forward: number }[],
): { env: Record<string, string>; rewritten: string[] } {
  const out = { ...env };
  const rewritten: string[] = [];
  for (const key of keys) {
    const before = out[key];
    if (before === undefined) continue;
    let value = before;
    for (const t of tunnels) {
      value = value.replace(new RegExp(`(?<![\\w.-])${escapeRe(t.name)}:${t.port}\\b`, "g"), `k8s-${t.name}:${t.forward}`);
    }
    if (value !== before) {
      out[key] = value;
      rewritten.push(key);
    }
  }
  return { env: out, rewritten };
}
```

- [ ] **Step 4: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./allocate.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-allocate.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/allocate.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-allocate.test.mjs
git commit -m "feat(detect): machine-wide port allocation and env tunnel rewrite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Planning and the gap-filling renderer

**Files:**
- Create: `packages/sandbox-core/fragment_detect/plan.ts`
- Create: `packages/sandbox-core/fragment_detect/render.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-render.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  - `SetupPlan = { name: string; fields: Record<string, FieldValue> }`
  - `Plan = { repo; root; fragmentPath; existing: string | null; services: ResolvedService[]; infrastructure: ResolvedInfra[]; setup: SetupPlan | null; envExample: Record<string, string[]>; unmatched: Finding[]; skipped: Skipped[] }`
  - `PlanOptions = { reposRoot: string; runner: Runner; localPath: string; portsPerSlot: number }`
  - `planFragment(root: string, opts: PlanOptions): Plan`. It throws `AllocationError`, or `RegistryError` from another repo's fragment, or a YAML error from an unparsable existing fragment.
  - `planSummary(plan: Plan)`: a JSON-friendly report without findings, used by MCP.
  - `FRAGMENT_HEADER: string`
  - `Rendered = { path: string; yaml: string; added: string[]; changed: boolean }`
  - `renderFragment(plan: Plan): Rendered`

**Why splicing:** `yaml`'s `parseDocument().toString()` doesn't round-trip hand-written files byte for byte. It pads flow sequences (`[X]` → `[ X ]`) and moves anchors off their key line. So the renderer uses the parsed document only for byte offsets (`node.range`) and inserts new text into the original string. The original text is never re-serialised.

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-render.test.mjs`:

```js
// End to end through planFragment + renderFragment: new files, gap-filling
// existing ones without touching a byte, and idempotence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import { planFragment, renderFragment } from "./dist/fragment_detect/index.js";
import { fixture, noTools } from "./fragment-detect-helpers.mjs";

const opts = (root) => ({
  reposRoot: path.dirname(root),
  runner: noTools,
  localPath: path.join(path.dirname(root), "no-local.yaml"),
  portsPerSlot: 20,
});

const DEMO = {
  "package.json": { workspaces: ["apps/*"] },
  "package-lock.json": "{}",
  "apps/backend/package.json": { name: "backend", scripts: { dev: "node server.js", test: "vitest run" }, dependencies: { pg: "8" } },
  "apps/backend/Dockerfile": "FROM node:22-alpine\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]\n",
  "apps/backend/k8s.yaml": [
    "kind: Deployment",
    "metadata: { name: backend }",
    "spec:",
    "  template:",
    "    metadata: { labels: { app: backend } }",
    "    spec:",
    "      containers:",
    "        - name: backend",
    "          image: backend:local",
    "          ports: [ { containerPort: 3000 } ]",
    "          readinessProbe: { httpGet: { path: /health, port: 3000 } }",
    "          env:",
    "            - { name: DATABASE_URL, value: 'postgres://u:p@postgres:5432/db' }",
    "---",
    "kind: Service",
    "metadata: { name: backend }",
    "spec: { selector: { app: backend }, ports: [ { port: 80, name: http } ] }",
    "",
  ].join("\n"),
  "apps/frontend/package.json": { name: "frontend", scripts: { dev: "next dev" }, dependencies: { next: "15" } },
  "apps/frontend/Dockerfile": "FROM node:22-alpine\nEXPOSE 3000\n",
  "charts/postgres.yaml": "kind: Deployment\nmetadata: { name: postgres }\nspec: { template: { spec: { containers: [ { name: pg, image: 'postgres:16', ports: [ { containerPort: 5432 } ] } ] } } }\n",
};

test("a new fragment: header, every section, guessed comments, the env rewrite", () => {
  const root = fixture(DEMO, "demo-services");
  const plan = planFragment(root, opts(root));
  const r = renderFragment(plan);
  assert.ok(r.yaml.startsWith("# Sandbox service-registry fragment for this repo."));
  const doc = parse(r.yaml);
  assert.deepEqual(Object.keys(doc), ["services", "infrastructure", "setup_services"]);
  assert.deepEqual(Object.keys(doc.services), ["backend", "frontend"]);
  const be = doc.services.backend;
  assert.equal(be.path, "apps/backend");
  assert.equal(be.internal_port, 3000);
  assert.equal(be.port_offset, 0);
  assert.equal(be.health_endpoint, "/health");
  assert.equal(be.image, "node:22-alpine");
  assert.equal(be.command, "cd apps/backend && exec npm run dev");
  assert.equal(be.setup_service, "demo-services-install");
  assert.equal(be.k8s_port, 80);
  assert.equal(be.environment.DATABASE_URL, "postgres://u:p@k8s-postgres:9050/db");
  assert.equal(doc.services.frontend.port_offset, 1);
  assert.deepEqual(doc.services.frontend.feature_router, {});
  assert.deepEqual(doc.infrastructure.postgres, {
    k8s_forward_port: 9050, internal_port: 5432, k8s_namespace: "default", k8s_pod_prefix: "postgres", health_endpoint: "postgres",
  });
  assert.deepEqual(doc.setup_services["demo-services-install"], {
    image: "node:22-alpine", command: "npm install", node_modules_volume: "node-modules",
  });
  assert.match(r.yaml, /type: api # guessed: no web, api or bin marker/);
  assert.match(r.yaml, /# guessed: compose environment|# guessed: k8s env; DATABASE_URL rewritten/);
  assert.ok(r.changed);
});

test("re-running after writing changes nothing", () => {
  const root = fixture(DEMO, "demo-services");
  const first = renderFragment(planFragment(root, opts(root)));
  mkdirSync(path.join(root, ".sandbox"), { recursive: true });
  writeFileSync(first.path, first.yaml);
  const second = renderFragment(planFragment(root, opts(root)));
  assert.equal(second.changed, false);
  assert.equal(second.yaml, first.yaml);
  assert.deepEqual(second.added, []);
});

/** Every original line survives, unmodified and in order. */
function assertKeptAllBytes(original, output) {
  const out = output.split("\n");
  let i = 0;
  for (const line of original.split("\n")) {
    while (i < out.length && out[i] !== line) i++;
    assert.ok(i < out.length, `original line lost or altered: ${JSON.stringify(line)}`);
    i++;
  }
}

test("gap-filling keeps anchors, flow sequences, comments and hand values byte for byte", () => {
  const existing = [
    "# hand-written",
    "x-shared:",
    "  env: &shared_env",
    "    HOME: \"{{home}}\"",
    "",
    "services:",
    "  backend:",
    "    path: apps/backend   # keep me",
    "    secrets: [API_KEY]",
    "    environment: *shared_env",
    "    port_offset: 7",
    "    setup_service: demo-install",
    "",
  ].join("\n");
  const root = fixture({ ...DEMO, ".sandbox/services.yaml": existing }, "demo-services");
  const plan = planFragment(root, opts(root));
  const r = renderFragment(plan);
  assertKeptAllBytes(existing, r.yaml);
  const doc = parse(r.yaml);
  assert.equal(doc.services.backend.port_offset, 7);
  assert.deepEqual(doc.services.backend.environment, { HOME: "{{home}}" });
  assert.equal(doc.services.backend.internal_port, 3000);
  assert.equal(doc.services.frontend.port_offset, 0);
  assert.equal(doc.services.frontend.setup_service, "demo-install");
  assert.deepEqual(Object.keys(doc.setup_services), ["demo-install"]);
  assert.ok(r.added.includes("services.backend.internal_port"));
  assert.ok(!r.added.some((a) => a === "services.backend.port_offset"));
});

test("an empty or comment-only fragment gets the sections appended after it", () => {
  for (const existing of ["", "# nothing yet\n"]) {
    const root = fixture({ ...DEMO, ".sandbox/services.yaml": existing }, "demo-services");
    const r = renderFragment(planFragment(root, opts(root)));
    assert.ok(r.yaml.startsWith(existing));
    assert.deepEqual(Object.keys(parse(r.yaml).services), ["backend", "frontend"]);
  }
});

test("a conflict is written as an also: comment", () => {
  const root = fixture({
    "package.json": { name: "api", scripts: { start: "node ." }, dependencies: { express: "4" } },
    "Dockerfile": "FROM node:22-alpine\nEXPOSE 8080\n",
    "k8s.yaml": "kind: Deployment\nmetadata: { name: api }\nspec: { template: { spec: { containers: [ { name: c, image: 'api:1', ports: [ { containerPort: 3000 } ] } ] } } }\n",
  }, "api");
  const r = renderFragment(planFragment(root, opts(root)));
  assert.match(r.yaml, /internal_port: 3000 # also: 8080 \(Dockerfile → EXPOSE\)/);
});

test(".env.example keys are listed on the path line, not declared", () => {
  const root = fixture({
    "package.json": { name: "api", scripts: { dev: "x" } },
    ".env.example": "export CLERK_SECRET_KEY=\nANTHROPIC_API_KEY=sk-...\n# comment\n",
  }, "api");
  const r = renderFragment(planFragment(root, opts(root)));
  assert.match(r.yaml, /path: "?\."? # \.env\.example also lists: ANTHROPIC_API_KEY, CLERK_SECRET_KEY/);
  assert.equal(parse(r.yaml).services.api.secrets, undefined);
});

test("compose depends_on on a datastore is dropped; on a sibling service it is kept", () => {
  const root = fixture({
    "docker-compose.yml": "services:\n  api:\n    build: ./api\n    depends_on: [cache, web]\n  web:\n    build: ./web\n  cache:\n    image: redis:7\n",
    "api/Dockerfile": "FROM golang:1.23\n",
    "web/Dockerfile": "FROM node:22\n",
  }, "shop");
  const doc = parse(renderFragment(planFragment(root, opts(root))).yaml);
  assert.deepEqual(doc.services.api.depends_on, ["web"]);
  assert.ok(doc.infrastructure.cache);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-render.test.mjs`
Expected: FAIL (`planFragment` is not exported).

- [ ] **Step 3: Write `plan.ts`**

```ts
/** The whole deterministic pass: detectors → correlation → precedence → allocation. */
import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import type { Runner } from "../machine_setup.js";
import { allocateForwards, allocateOffsets, rewriteEnv, takenPorts } from "./allocate.js";
import { detectCompose } from "./compose.js";
import { correlate } from "./correlate.js";
import { detectDockerfiles } from "./dockerfile.js";
import { listRepoFiles, readText } from "./files.js";
import { detectHelm } from "./helm.js";
import { detectK8s } from "./k8s.js";
import { detectKustomize } from "./kustomize.js";
import { detectPackages } from "./package.js";
import { resolveInfra, resolveService, type ResolvedInfra, type ResolvedService } from "./precedence.js";
import { guessed, stated, type DetectContext, type FieldValue, type Finding, type Skipped, type Workspace } from "./types.js";
import { detectWorkspace } from "./workspace.js";

export interface SetupPlan {
  name: string;
  fields: Record<string, FieldValue>;
}

export interface Plan {
  repo: string;
  root: string;
  fragmentPath: string;
  /** The existing fragment's text, or null when the repo has none. */
  existing: string | null;
  services: ResolvedService[];
  infrastructure: ResolvedInfra[];
  setup: SetupPlan | null;
  /** Keys listed in .env.example-style files, per service name. */
  envExample: Record<string, string[]>;
  unmatched: Finding[];
  skipped: Skipped[];
}

export interface PlanOptions {
  reposRoot: string;
  runner: Runner;
  localPath: string;
  portsPerSlot: number;
}

const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

function safely<T>(skipped: Skipped[], label: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    skipped.push({ item: label, reason: `${label} failed: ${e instanceof Error ? e.message : String(e)}` });
    return fallback;
  }
}

function envExampleKeys(ctx: DetectContext, dir: string): string[] {
  const keys = new Set<string>();
  const candidates = ENV_EXAMPLES.flatMap((n) => [path.posix.join(dir, n), n]);
  for (const file of new Set(candidates)) {
    if (!ctx.files.includes(file)) continue;
    for (const line of readText(ctx, file).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

export function planFragment(root: string, opts: PlanOptions): Plan {
  const abs = path.resolve(root);
  const repo = path.basename(abs);
  const fragmentPath = path.join(abs, ".sandbox", "services.yaml");
  const existing = fs.existsSync(fragmentPath) ? fs.readFileSync(fragmentPath, "utf8") : null;
  // An existing fragment that doesn't parse can't be gap-filled: let the YAML error propagate.
  const existingDoc: Record<string, any> | null = existing ? (parseYaml(existing) ?? null) : null;
  const ctx: DetectContext = { root: abs, files: listRepoFiles(abs, opts.runner), runner: opts.runner, skipped: [] };

  const existingSetup =
    Object.values(existingDoc?.services ?? {})
      .map((s: any) => s?.setup_service)
      .find((s): s is string => typeof s === "string") ?? null;
  const noWorkspace: Workspace = { pm: "npm", packageDirs: [], setupName: null, setupFields: {} };
  const ws = safely(ctx.skipped, "workspace detection", noWorkspace, () => detectWorkspace(ctx, existingSetup));
  const findings: Finding[] = [
    ...safely(ctx.skipped, "package.json detection", [] as Finding[], () => detectPackages(ctx, ws)),
    ...safely(ctx.skipped, "Dockerfile detection", [] as Finding[], () => detectDockerfiles(ctx)),
    ...safely(ctx.skipped, "k8s manifest detection", [] as Finding[], () => detectK8s(ctx)),
    ...safely(ctx.skipped, "Helm detection", [] as Finding[], () => detectHelm(ctx)),
    ...safely(ctx.skipped, "kustomize detection", [] as Finding[], () => detectKustomize(ctx)),
    ...safely(ctx.skipped, "compose detection", [] as Finding[], () => detectCompose(ctx)),
  ];

  const corr = correlate(findings, repo);
  const services = corr.services.map(resolveService);
  const infrastructure = corr.infrastructure.map(resolveInfra);
  const names = new Set(services.map((s) => s.name));

  // Allocation: never for an entry that already has a value in the file.
  const inFile = (section: string, name: string, key: string) => existingDoc?.[section]?.[name]?.[key] !== undefined;
  const taken = takenPorts(opts.reposRoot, fragmentPath, opts.localPath, existingDoc);
  const offsets = allocateOffsets(
    services.filter((s) => !inFile("services", s.name, "port_offset")).map((s) => s.name),
    taken.offsets,
    opts.portsPerSlot,
  );
  for (const s of services) {
    const n = offsets.get(s.name);
    if (n !== undefined) s.fields.port_offset = stated(n, "lowest free offset across registered repos");
  }
  const forwards = allocateForwards(
    infrastructure.filter((i) => !inFile("infrastructure", i.name, "k8s_forward_port")).map((i) => i.name),
    taken.forwards,
  );
  for (const i of infrastructure) {
    const n = forwards.get(i.name);
    if (n !== undefined) i.fields.k8s_forward_port = stated(n, "lowest free forward port from 9050");
  }

  // k8s env addressed at in-cluster infrastructure → the sandbox tunnel.
  const tunnels = infrastructure.map((i) => ({
    name: i.name,
    port: Number(existingDoc?.infrastructure?.[i.name]?.internal_port ?? i.fields.internal_port.value),
    forward: Number(existingDoc?.infrastructure?.[i.name]?.k8s_forward_port ?? i.fields.k8s_forward_port?.value),
  }));
  for (const s of services) {
    const env = s.fields.environment;
    if (!env) continue;
    const { env: next, rewritten } = rewriteEnv(env.value as Record<string, string>, s.k8sEnvKeys, tunnels);
    if (rewritten.length) {
      s.fields.environment = guessed(next, `${env.source}; ${rewritten.join(", ")} rewritten from the in-cluster address to the sandbox tunnel`);
    }
  }

  // depends_on can only name services this fragment defines.
  for (const s of services) {
    const d = s.fields.depends_on;
    if (!d) continue;
    const kept = (d.value as string[]).filter((n) => names.has(n) && n !== s.name);
    if (kept.length) s.fields.depends_on = { ...d, value: kept };
    else delete s.fields.depends_on;
  }

  // The shared install runs on the same image as the services that use its node_modules.
  const nodeServices = services.filter((s) => s.fields.setup_service);
  const setup: SetupPlan | null =
    ws.setupName && nodeServices.length
      ? {
          name: ws.setupName,
          fields: {
            image: { ...nodeServices[0].fields.image, source: `same image as ${nodeServices[0].name}` },
            ...ws.setupFields,
          },
        }
      : null;

  const envExample: Record<string, string[]> = {};
  for (const s of services) {
    const declared = new Set([
      ...Object.keys((s.fields.environment?.value as Record<string, string>) ?? {}),
      ...((s.fields.secrets?.value as string[]) ?? []),
    ]);
    const keys = envExampleKeys(ctx, s.dir).filter((k) => !declared.has(k));
    if (keys.length) envExample[s.name] = keys;
  }

  return {
    repo,
    root: abs,
    fragmentPath,
    existing,
    services,
    infrastructure,
    setup,
    envExample,
    unmatched: corr.unmatched,
    skipped: [...ctx.skipped, ...corr.skipped],
  };
}

/** The plan as plain JSON for reports (no raw findings). */
export function planSummary(plan: Plan) {
  const fields = (f: Record<string, FieldValue>) =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { value: v.value, source: v.source, confidence: v.confidence }]));
  return {
    repo: plan.repo,
    fragment: plan.fragmentPath,
    existed: plan.existing !== null,
    services: plan.services.map((s) => ({
      name: s.name,
      dir: s.dir,
      fields: fields(s.fields),
      conflicts: s.conflicts.map((c) => ({ key: c.key, chosen: c.chosen, also: c.also })),
    })),
    infrastructure: plan.infrastructure.map((i) => ({ name: i.name, fields: fields(i.fields) })),
    setup: plan.setup ? { name: plan.setup.name, fields: fields(plan.setup.fields) } : null,
    envExample: plan.envExample,
    skipped: plan.skipped,
  };
}
```

- [ ] **Step 4: Write `render.ts`**

```ts
/**
 * Plan → fragment text. A new file is written whole. For an existing file, new
 * keys and entries are spliced into the original text at offsets taken from
 * the parsed document, so the hand-written bytes are never re-serialised:
 * yaml's toString() pads flow sequences and moves anchors.
 */
import { isMap, parseDocument, stringify, type Node, type YAMLMap } from "yaml";

import type { Plan } from "./plan.js";
import type { FieldValue } from "./types.js";

export const FRAGMENT_HEADER = [
  "# Sandbox service-registry fragment for this repo.",
  "#",
  "# `sandbox registry sync` (run by `sandbox setup`) merges every",
  "# <repo>/.sandbox/services.yaml under paths.repos_root into",
  "# ~/.sandbox/services.yaml. Only `services:`, `setup_services:` and",
  "# `infrastructure:` may appear here; `repo:` is the checkout's directory name",
  "# and `repos:` is derived. Generated by `sandbox detect`; re-running it only",
  "# adds what is missing, so edit freely.",
  "",
  "",
].join("\n");

const SERVICE_KEYS = [
  "path", "type", "archetype", "test", "internal_port", "port_offset", "health_endpoint", "setup_service",
  "image", "command", "memory_limit", "memory_reservation", "node_modules_volume", "environment", "secrets",
  "k8s_deployment", "k8s_namespace", "k8s_port", "k8s_port_name", "k8s_pod_prefix", "feature_router", "depends_on",
];
const INFRA_KEYS = ["k8s_forward_port", "internal_port", "k8s_namespace", "k8s_pod_prefix", "health_endpoint"];
const SETUP_KEYS = ["image", "command", "node_modules_volume"];

export interface Rendered {
  path: string;
  yaml: string;
  /** Dotted paths of every key added, e.g. `services.api.internal_port`. */
  added: string[];
  changed: boolean;
}

interface KeyLine {
  key: string;
  fv: FieldValue;
  also: FieldValue[];
  note?: string;
}

function commentFor(line: KeyLine): string {
  const parts: string[] = [];
  if (line.note) parts.push(line.note);
  if (line.fv.confidence === "guessed") parts.push(`guessed: ${line.fv.source}`);
  if (line.fv.confidence === "inferred") parts.push(`inferred by Claude: ${line.fv.source}`);
  for (const a of line.also) parts.push(`also: ${JSON.stringify(a.value)} (${a.source})`);
  return parts.length ? ` # ${parts.join("; ").replace(/\n/g, " ")}` : "";
}

/** `key: value` lines at *indent*, the comment on the first line. */
function keyBlock(line: KeyLine, indent: string): string {
  const lines = stringify({ [line.key]: line.fv.value }, { lineWidth: 0 }).trimEnd().split("\n");
  lines[0] += commentFor(line);
  return lines.map((l) => indent + l).join("\n") + "\n";
}

function entryBlock(name: string, lines: KeyLine[], indent: string): string {
  return `${indent}${name}:\n` + lines.map((l) => keyBlock(l, `${indent}  `)).join("");
}

/** Offset just past the end of the line containing *offset - 1*. */
function endOfLine(text: string, offset: number): number {
  const nl = text.indexOf("\n", Math.max(0, offset - 1));
  return nl === -1 ? text.length : nl + 1;
}

function lastItemEnd(map: YAMLMap): number {
  const last = map.items[map.items.length - 1];
  const node = (last.value ?? last.key) as Node;
  return node.range ? node.range[1] : 0;
}

function indentOf(text: string, map: YAMLMap): string {
  const start = (map.items[0].key as Node).range?.[0] ?? 0;
  return " ".repeat(start - (text.lastIndexOf("\n", start - 1) + 1));
}

type Entries = [name: string, lines: KeyLine[]][];

function sections(plan: Plan): [string, Entries][] {
  const pick = (fields: Record<string, FieldValue>, keys: string[], extra: (k: string) => Partial<KeyLine> = () => ({})) =>
    keys.filter((k) => fields[k]).map((k) => ({ key: k, fv: fields[k], also: [], ...extra(k) }) as KeyLine);
  const services: Entries = plan.services.map((s) => [
    s.name,
    pick(s.fields, SERVICE_KEYS, (k) => ({
      also: s.conflicts.find((c) => c.key === k)?.also ?? [],
      note: k === "path" && plan.envExample[s.name]
        ? `.env.example also lists: ${plan.envExample[s.name].join(", ")} — declare required ones under secrets:`
        : undefined,
    })),
  ]);
  const infra: Entries = plan.infrastructure.map((i) => [i.name, pick(i.fields, INFRA_KEYS)]);
  const setup: Entries = plan.setup ? [[plan.setup.name, pick(plan.setup.fields, SETUP_KEYS)]] : [];
  return [["services", services], ["infrastructure", infra], ["setup_services", setup]];
}

export function renderFragment(plan: Plan): Rendered {
  const original = plan.existing ?? "";
  const doc = parseDocument(original);
  const root = isMap(doc.contents) ? doc.contents : null;
  const edits: { at: number; seq: number; text: string }[] = [];
  const appended: string[] = [];
  const added: string[] = [];
  let seq = 0;

  for (const [section, entries] of sections(plan)) {
    if (!entries.length) continue;
    const sec = root?.get(section, true);
    if (!isMap(sec) || sec.flow || !sec.items.length) {
      // Present but empty, null or flow-styled: extending it means rewriting it, and appending
      // a second `services:` would be a duplicate key. Leave it to the human.
      if (sec !== undefined) continue;
      appended.push(`${section}:\n` + entries.map(([name, lines]) => entryBlock(name, lines, "  ")).join(""));
      for (const [name, lines] of entries) added.push(...lines.map((l) => `${section}.${name}.${l.key}`));
      continue;
    }
    const newEntries: string[] = [];
    for (const [name, lines] of entries) {
      const entry = sec.get(name, true);
      if (entry === undefined) {
        newEntries.push(entryBlock(name, lines, indentOf(original, sec)));
        added.push(...lines.map((l) => `${section}.${name}.${l.key}`));
        continue;
      }
      if (!isMap(entry) || entry.flow || !entry.items.length) continue; // a hand-shaped entry we can't extend safely
      const missing = lines.filter((l) => !entry.has(l.key));
      if (!missing.length) continue;
      const routerLine = missing.find((l) => l.key === "feature_router");
      const forward = entry.get("k8s_forward_port");
      if (routerLine && typeof forward === "number") {
        routerLine.fv = { ...routerLine.fv, value: { remote_upstream: `k8s-${name}:${forward}` } };
      }
      const indent = indentOf(original, entry);
      edits.push({ at: endOfLine(original, lastItemEnd(entry)), seq: seq++, text: missing.map((l) => keyBlock(l, indent)).join("") });
      added.push(...missing.map((l) => `${section}.${name}.${l.key}`));
    }
    if (newEntries.length) {
      edits.push({ at: endOfLine(original, lastItemEnd(sec)), seq: seq++, text: newEntries.join("") });
    }
  }

  let yaml = original;
  // Apply back to front; at one offset, the earlier edit must end up first in the text.
  for (const e of edits.sort((a, b) => b.at - a.at || b.seq - a.seq)) {
    const sep = e.at === yaml.length && yaml.length && !yaml.endsWith("\n") ? "\n" : "";
    yaml = yaml.slice(0, e.at) + sep + e.text + yaml.slice(e.at);
  }
  if (appended.length) {
    const prefix = yaml === "" ? FRAGMENT_HEADER : yaml.endsWith("\n\n") ? yaml : yaml.endsWith("\n") ? `${yaml}\n` : `${yaml}\n\n`;
    yaml = prefix + appended.join("\n");
  }
  return { path: plan.fragmentPath, yaml, added, changed: yaml !== original };
}
```

- [ ] **Step 5: Export them**

Append to `fragment_detect/index.ts`:

```ts
export * from "./plan.js";
export * from "./render.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-render.test.mjs`
Expected: PASS, 7 tests.

If the anchor test fails because `sec.get(name, true)` returns an `Alias` for `environment: *shared_env`, check that `entry.has("environment")` is true for the alias pair. It is, because `has` checks keys, not values. Fix any mismatch in `render.ts`, not in the test.

- [ ] **Step 7: Run every fragment-detect test**

Run: `cd packages/sandbox-core && node --test fragment-detect-*.test.mjs`
Expected: PASS, all files.

- [ ] **Step 8: Commit**

```bash
git add packages/sandbox-core/fragment_detect/plan.ts packages/sandbox-core/fragment_detect/render.ts \
  packages/sandbox-core/fragment_detect/index.ts packages/sandbox-core/fragment-detect-render.test.mjs
git commit -m "feat(detect): plan the fragment and splice it into the existing file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Validation and writing

**Files:**
- Create: `packages/sandbox-core/fragment_detect/validate.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Modify: `packages/sandbox-core/package.json`, `package-lock.json` (add `ajv`)
- Test: `packages/sandbox-core/fragment-detect-validate.test.mjs`

**Interfaces:**
- Consumes: Task 9 (`Plan`, `Rendered`), `discoverFragments`/`mergeRegistry`/`RegistryError` from `../registry_sync.js`, `sandboxRoot` from `../config.js`, and the schema at `apps/cli/infra/schemas/services-fragment.schema.json`.
- Produces: `defaultSchemaPath(): string`, `validateFragment(rendered: Rendered, plan: Plan, reposRoot: string, schemaPath?: string): string[]` (an empty array means valid), and `writeFragment(rendered: Rendered): void`.

- [ ] **Step 1: Add the dependency**

Run: `npm install ajv@^8.20.0 -w sandbox-core`
Expected: `packages/sandbox-core/package.json` gains `"ajv": "^8.20.0"`. `ajv` is already in the lockfile as a transitive dependency, so nothing new is downloaded.

- [ ] **Step 2: Write the failing tests**

`packages/sandbox-core/fragment-detect-validate.test.mjs`:

```js
// The last gate before a write: the JSON Schema, then a trial merge against
// every other repo's fragment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { planFragment, renderFragment, validateFragment, writeFragment } from "./dist/fragment_detect/index.js";
import { fixture, noTools } from "./fragment-detect-helpers.mjs";

const opts = (root) => ({ reposRoot: path.dirname(root), runner: noTools, localPath: "/nonexistent", portsPerSlot: 20 });
const SHOP = { "package.json": { name: "shop", scripts: { dev: "node ." }, dependencies: { express: "4" } } };

test("a generated fragment is valid", () => {
  const root = fixture(SHOP, "shop");
  const plan = planFragment(root, opts(root));
  assert.deepEqual(validateFragment(renderFragment(plan), plan, path.dirname(root)), []);
});

test("a service name another repo already has fails the trial merge", () => {
  const root = fixture(SHOP, "shop");
  const other = path.join(path.dirname(root), "legacy", ".sandbox");
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, "services.yaml"), "services:\n  shop:\n    path: .\n    port_offset: 19\n");
  const plan = planFragment(root, opts(root));
  const errors = validateFragment(renderFragment(plan), plan, path.dirname(root));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /services\.shop is defined by both legacy and shop/);
});

test("a schema violation is reported with its path", () => {
  const root = fixture(SHOP, "shop");
  const plan = planFragment(root, opts(root));
  const rendered = renderFragment(plan);
  const broken = { ...rendered, yaml: rendered.yaml.replace("type: api", "type: daemon") };
  const errors = validateFragment(broken, plan, path.dirname(root));
  assert.ok(errors.some((e) => e.startsWith("/services/shop/type")), errors.join("\n"));
});

test("writeFragment creates .sandbox/ and writes the text", () => {
  const root = fixture(SHOP, "shop");
  const rendered = renderFragment(planFragment(root, opts(root)));
  assert.ok(!existsSync(rendered.path));
  writeFragment(rendered);
  assert.equal(readFileSync(rendered.path, "utf8"), rendered.yaml);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-validate.test.mjs`
Expected: FAIL (`validateFragment` is not exported).

- [ ] **Step 4: Write `validate.ts`**

```ts
/** The last gate before writing: the JSON Schema, then a trial merge with every other fragment. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import AjvModule from "ajv";
import { parse as parseYaml } from "yaml";

import { sandboxRoot } from "../config.js";
import { discoverFragments, mergeRegistry, RegistryError } from "../registry_sync.js";
import type { Plan } from "./plan.js";
import type { Rendered } from "./render.js";

// ajv is CJS: under Node ESM the default import is the module object, and under esbuild it's the class.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule;

export function defaultSchemaPath(): string {
  return path.join(sandboxRoot(), "infra", "schemas", "services-fragment.schema.json");
}

export function validateFragment(rendered: Rendered, plan: Plan, reposRoot: string, schemaPath = defaultSchemaPath()): string[] {
  let doc: Record<string, any>;
  try {
    doc = parseYaml(rendered.yaml) ?? {};
  } catch (e) {
    return [`generated YAML does not parse: ${e instanceof Error ? e.message : String(e)}`];
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
  const errors = validate(doc)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  try {
    const others = discoverFragments(reposRoot).filter((f) => path.resolve(f.path) !== path.resolve(plan.fragmentPath));
    mergeRegistry([...others, { repo: plan.repo, path: plan.fragmentPath, doc }], {
      defaults: {},
      local: {},
      paths: { home: os.homedir(), repos_root: reposRoot, workspaces_root: reposRoot },
    });
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    errors.push(e.message);
  }
  return errors;
}

export function writeFragment(rendered: Rendered): void {
  fs.mkdirSync(path.dirname(rendered.path), { recursive: true });
  fs.writeFileSync(rendered.path, rendered.yaml);
}
```

- [ ] **Step 5: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./validate.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-validate.test.mjs`
Expected: PASS, 4 tests. If `tsc` rejects the `Ajv` cast, keep the runtime expression and change only the type annotation until it compiles. The `default ?? module` fallback is what makes it work under both Node and esbuild.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-core/fragment_detect/validate.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-validate.test.mjs packages/sandbox-core/package.json package-lock.json
git commit -m "feat(detect): validate against the fragment schema and a trial merge before writing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Claude pass, core side (questions and constrained answers)

**Files:**
- Create: `packages/sandbox-core/fragment_detect/assist.ts`
- Modify: `packages/sandbox-core/fragment_detect/index.ts`
- Test: `packages/sandbox-core/fragment-detect-assist.test.mjs`

**Interfaces:**
- Consumes: Task 9 (`Plan`, `renderFragment`) and Task 7 (`resolveService`).
- Produces:
  - `QuestionKind = "command" | "health_endpoint" | "environment" | "secrets" | "depends_on" | "conflict" | "unmatched"`
  - `Question = { id: string; kind: QuestionKind; service: string | null; prompt: string; facts: Record<string, unknown>; choices?: unknown[] }`
  - `Answer = { item: string; value: unknown; reason: string; files_read: string[] }`
  - `Resolver = (repoRoot: string, questions: Question[]) => Promise<Answer[]>`
  - `ApplyResult = { plan: Plan; accepted: string[]; rejected: { item: string; reason: string }[] }`
  - `ANSWER_SCHEMA` (a draft-07 JSON Schema object for `{ answers: Answer[] }`)
  - `collectQuestions(plan: Plan): Question[]`
  - `applyAnswers(plan: Plan, answers: Answer[]): ApplyResult` (doesn't mutate its input)
  - `assistPrompt(questions: Question[]): string`

- [ ] **Step 1: Write the failing tests**

`packages/sandbox-core/fragment-detect-assist.test.mjs`:

```js
// The Claude pass can only answer questions the deterministic pass asked, and
// only with values of the right shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { applyAnswers, assistPrompt, collectQuestions, planFragment, renderFragment } from "./dist/fragment_detect/index.js";
import { fixture, noTools } from "./fragment-detect-helpers.mjs";

const opts = (root) => ({ reposRoot: path.dirname(root), runner: noTools, localPath: "/nonexistent", portsPerSlot: 20 });

function goRepo(extra = {}) {
  const root = fixture({
    "package.json": { workspaces: ["services/*"] },
    "services/api/Dockerfile": "FROM golang:1.23\nEXPOSE 9000\nCMD [\"/app/api\"]\n",
    "services/web/package.json": { name: "web", scripts: { dev: "vite" }, dependencies: { vite: "5" } },
    "services/web/.env.example": "API_URL=\nSTRIPE_KEY=\n",
    "deploy/pay.yaml": "kind: Deployment\nmetadata: { name: payments }\nspec: { template: { spec: { containers: [ { name: c, image: 'pay:1', ports: [ { containerPort: 7000 } ] } ] } } }\n",
    ...extra,
  }, "shop");
  return planFragment(root, opts(root));
}

test("questions come only from guesses, env examples, siblings and unmatched resources", () => {
  const ids = collectQuestions(goRepo()).map((q) => q.id).sort();
  assert.deepEqual(ids, [
    "api.command",
    "api.depends_on",
    "api.health_endpoint",
    "unmatched.payments",
    "web.depends_on",
    "web.environment",
    "web.health_endpoint",
    "web.secrets",
  ]);
});

test("an accepted answer becomes an inferred value, rendered with its reason", () => {
  const plan = goRepo();
  const r = applyAnswers(plan, [
    { item: "api.command", value: "cd services/api && exec go run ./cmd/api", reason: "Makefile dev target", files_read: ["Makefile"] },
  ]);
  assert.deepEqual(r.accepted, ["api.command"]);
  assert.equal(r.plan.services.find((s) => s.name === "api").fields.command.confidence, "inferred");
  assert.match(renderFragment(r.plan).yaml, /command: cd services\/api && exec go run \.\/cmd\/api # inferred by Claude: Makefile dev target/);
  assert.equal(plan.services.find((s) => s.name === "api").fields.command.confidence, "guessed", "input plan untouched");
});

test("answers outside the questions, of the wrong shape, or repeated are rejected", () => {
  const r = applyAnswers(goRepo(), [
    { item: "web.command", value: "npm start", reason: "x", files_read: [] },
    { item: "api.health_endpoint", value: "healthz", reason: "x", files_read: [] },
    { item: "web.secrets", value: ["NOT_LISTED"], reason: "x", files_read: [] },
    { item: "api.depends_on", value: ["web"], reason: "calls it", files_read: [] },
    { item: "api.depends_on", value: [], reason: "again", files_read: [] },
  ]);
  assert.deepEqual(r.accepted, ["api.depends_on"]);
  assert.deepEqual(r.rejected.map((x) => x.item), ["web.command", "api.health_endpoint", "web.secrets", "api.depends_on"]);
});

test("an environment answer adds keys but never replaces a deterministic one", () => {
  const plan = goRepo({ "docker-compose.yml": "services:\n  web:\n    build: ./services/web\n    environment: { API_URL: http://api:9000 }\n" });
  const r = applyAnswers(plan, [
    { item: "web.environment", value: { API_URL: "http://wrong", MODE: "dev" }, reason: "README", files_read: [] },
  ]);
  const env = r.plan.services.find((s) => s.name === "web").fields.environment;
  assert.deepEqual(env.value, { API_URL: "http://api:9000", MODE: "dev" });
  assert.equal(env.confidence, "inferred");
});

test("an unmatched resource attached by Claude only adds fields the service lacks", () => {
  const r = applyAnswers(goRepo(), [{ item: "unmatched.payments", value: "api", reason: "same binary", files_read: [] }]);
  const api = r.plan.services.find((s) => s.name === "api");
  assert.equal(api.fields.internal_port.value, 9000, "Dockerfile port stays");
  assert.equal(api.fields.k8s_pod_prefix.value, "payments");
  assert.equal(api.fields.k8s_pod_prefix.confidence, "inferred");
  assert.equal(r.plan.unmatched.length, 0);
  assert.ok(!r.plan.skipped.some((s) => s.reason.includes("payments")));
});

test("no question for a field the existing file already sets", () => {
  const plan = goRepo({ ".sandbox/services.yaml": "services:\n  api:\n    command: make run\n" });
  assert.ok(!collectQuestions(plan).some((q) => q.id === "api.command"));
});

test("the prompt carries every question id and the read-only rules", () => {
  const qs = collectQuestions(goRepo());
  const prompt = assistPrompt(qs);
  for (const q of qs) assert.ok(prompt.includes(`"${q.id}"`));
  assert.match(prompt, /Leave a question out/);
  assert.match(prompt, /Never put credentials/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc; node --test fragment-detect-assist.test.mjs`
Expected: FAIL (`collectQuestions` is not exported).

- [ ] **Step 3: Write `assist.ts`**

```ts
/**
 * The optional Claude pass, core side (spec §6): which questions to ask, and
 * the rules an answer must pass before it lands in the plan. The CLI supplies
 * the Resolver that actually talks to Claude; core never does.
 */
import { parse as parseYaml } from "yaml";

import type { Plan } from "./plan.js";
import { resolveService } from "./precedence.js";
import type { FieldValue } from "./types.js";

export type QuestionKind = "command" | "health_endpoint" | "environment" | "secrets" | "depends_on" | "conflict" | "unmatched";

export interface Question {
  id: string;
  kind: QuestionKind;
  service: string | null;
  prompt: string;
  facts: Record<string, unknown>;
  choices?: unknown[];
}

export interface Answer {
  item: string;
  value: unknown;
  reason: string;
  files_read: string[];
}

export type Resolver = (repoRoot: string, questions: Question[]) => Promise<Answer[]>;

export interface ApplyResult {
  plan: Plan;
  accepted: string[];
  rejected: { item: string; reason: string }[];
}

export const ANSWER_SCHEMA = {
  type: "object",
  required: ["answers"],
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "value", "reason", "files_read"],
        additionalProperties: false,
        properties: {
          item: { type: "string" },
          value: {},
          reason: { type: "string" },
          files_read: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export function collectQuestions(plan: Plan): Question[] {
  const existing = plan.existing ? (parseYaml(plan.existing) ?? {}) : {};
  const inFile = (svc: string, key: string) => existing?.services?.[svc]?.[key] !== undefined;
  const names = plan.services.map((s) => s.name);
  const qs: Question[] = [];
  for (const s of plan.services) {
    const f = s.fields;
    const ask = (key: string, q: Omit<Question, "id" | "service">) => {
      if (!inFile(s.name, key)) qs.push({ id: `${s.name}.${key}`, service: s.name, ...q });
    };
    if (f.command?.confidence === "guessed") {
      ask("command", {
        kind: "command",
        prompt: `What command starts ${s.name} for local development? It runs with the repo root mounted at /app as the working directory.`,
        facts: { dir: s.dir, guess: f.command.value, why: f.command.source },
      });
    }
    if (f.health_endpoint?.confidence === "guessed") {
      ask("health_endpoint", {
        kind: "health_endpoint",
        prompt: `Which HTTP path answers 200 when ${s.name} is healthy? Answer "" if it has none.`,
        facts: { dir: s.dir, port: f.internal_port?.value },
      });
    }
    const example = plan.envExample[s.name] ?? [];
    if (example.length) {
      ask("environment", {
        kind: "environment",
        prompt: `Which environment variables does ${s.name} need for local development, with development values? Leave secrets out.`,
        facts: { dir: s.dir, env_example_keys: example, current: f.environment?.value ?? {} },
      });
      if (!f.secrets) {
        ask("secrets", {
          kind: "secrets",
          prompt: `Which of these keys must be set for ${s.name} to start at all? A declared secret that is missing stops \`sandbox up\`.`,
          facts: { dir: s.dir },
          choices: example,
        });
      }
    }
    const others = names.filter((n) => n !== s.name);
    if (others.length && !f.depends_on) {
      ask("depends_on", {
        kind: "depends_on",
        prompt: `Which of these services must be running before ${s.name} starts (it calls them at startup)? Answer [] for none.`,
        facts: { dir: s.dir },
        choices: others,
      });
    }
    for (const c of s.conflicts) {
      ask(c.key, {
        kind: "conflict",
        prompt: `Sources disagree on ${s.name}.${c.key}. Which value is right for local development?`,
        facts: { sources: [c.chosen, ...c.also].map((x) => ({ value: x.value, source: x.source })) },
        choices: [c.chosen.value, ...c.also.map((a) => a.value)],
      });
    }
  }
  for (const u of plan.unmatched) {
    qs.push({
      id: `unmatched.${u.name}`,
      kind: "unmatched",
      service: null,
      prompt: `${u.file} defines ${u.name}, but no source directory matched it. Which service is it? Answer null if its code lives in another repo.`,
      facts: { file: u.file, image: u.image ?? null },
      choices: [...names, null],
    });
  }
  return qs;
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
const subsetOf = (v: unknown, choices: unknown[]): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && choices.includes(x));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function applyAnswers(plan: Plan, answers: Answer[]): ApplyResult {
  const next: Plan = structuredClone(plan);
  const questions = new Map(collectQuestions(plan).map((q) => [q.id, q]));
  const accepted: string[] = [];
  const rejected: { item: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const a of answers) {
    const q = questions.get(a.item);
    if (!q) {
      rejected.push({ item: a.item, reason: "not one of the questions asked" });
      continue;
    }
    if (seen.has(a.item)) {
      rejected.push({ item: a.item, reason: "answered twice; kept the first" });
      continue;
    }
    seen.add(a.item);
    const reason = a.reason?.trim() || "no reason given";
    const inferred = (value: unknown): FieldValue => ({ value, source: reason, confidence: "inferred" });
    const svc = q.service ? next.services.find((s) => s.name === q.service) : undefined;
    let problem: string | null = null;

    switch (q.kind) {
      case "command":
        if (typeof a.value === "string" && a.value.trim()) svc!.fields.command = inferred(a.value.trim());
        else problem = "expected a non-empty command string";
        break;
      case "health_endpoint":
        if (typeof a.value === "string" && (a.value === "" || a.value.startsWith("/"))) svc!.fields.health_endpoint = inferred(a.value);
        else problem = 'expected "" or a path starting with /';
        break;
      case "environment": {
        if (!isStringMap(a.value)) {
          problem = "expected an object of string values";
          break;
        }
        const current = (svc!.fields.environment?.value ?? {}) as Record<string, string>;
        const merged = Object.fromEntries(Object.entries({ ...a.value, ...current }).sort(([x], [y]) => x.localeCompare(y)));
        const before = svc!.fields.environment?.source;
        svc!.fields.environment = inferred(merged);
        if (before) svc!.fields.environment.source = `${before}; Claude added keys: ${reason}`;
        break;
      }
      case "secrets":
        if (subsetOf(a.value, q.choices ?? [])) {
          if (a.value.length) svc!.fields.secrets = inferred([...a.value].sort());
        } else problem = "expected a list of keys from .env.example";
        break;
      case "depends_on":
        if (subsetOf(a.value, q.choices ?? [])) {
          if (a.value.length) svc!.fields.depends_on = inferred([...a.value].sort());
        } else problem = "expected a list of this repo's other services";
        break;
      case "conflict": {
        const choice = (q.choices ?? []).find((c) => same(c, a.value));
        if (choice === undefined) {
          problem = "not one of the conflicting values";
          break;
        }
        const key = q.id.slice(q.service!.length + 1);
        svc!.fields[key] = inferred(choice);
        svc!.conflicts = svc!.conflicts.filter((c) => c.key !== key);
        break;
      }
      case "unmatched": {
        if (a.value === null) break;
        const target = typeof a.value === "string" ? next.services.find((s) => s.name === a.value) : undefined;
        const finding = next.unmatched.find((u) => `unmatched.${u.name}` === q.id);
        if (!target || !finding) {
          problem = "expected one of this repo's services, or null";
          break;
        }
        const fresh = resolveService({ name: target.name, dir: target.dir, findings: [...target.findings, finding] });
        for (const [k, fv] of Object.entries(fresh.fields)) {
          if (!(k in target.fields)) target.fields[k] = { ...fv, confidence: "inferred", source: `${fv.source}; matched by Claude: ${reason}` };
        }
        target.findings.push(finding);
        next.unmatched = next.unmatched.filter((u) => u !== finding);
        next.skipped = next.skipped.filter((s) => !(s.item === finding.file && s.reason.includes(` ${finding.name} — `)));
        break;
      }
    }
    if (problem) rejected.push({ item: a.item, reason: problem });
    else accepted.push(a.item);
  }
  return { plan: next, accepted, rejected };
}

export function assistPrompt(questions: Question[]): string {
  return [
    "You are helping generate a sandbox service-registry fragment for the repository in your working directory.",
    "A deterministic scan already filled every field it could read from package manifests, Dockerfiles, compose files and Kubernetes manifests.",
    "The questions below are the fields it had to guess. Answer each one from the repository's own files, using Read, Glob and Grep.",
    "",
    "Rules:",
    "- Answer only the questions listed, using each question's `id` as `item`.",
    "- When a question has `choices`, `value` must be one of them; for list questions, a subset of them.",
    "- Leave a question out if the repository doesn't settle it. A missing answer keeps the scan's guess; a wrong answer is worse than none.",
    "- Never put credentials, tokens or keys in environment values. Those belong in `secrets`.",
    "- `reason` is one short sentence naming the evidence, e.g. \"apps/api/src/main.ts registers GET /healthz\". It is written into the file as a comment.",
    "- `files_read` lists the files that support the answer.",
    "",
    "Questions (JSON):",
    JSON.stringify(questions, null, 2),
  ].join("\n");
}
```

- [ ] **Step 4: Export it**

Append to `fragment_detect/index.ts`:

```ts
export * from "./assist.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sandbox-core && npx tsc && node --test fragment-detect-assist.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-core/fragment_detect/assist.ts packages/sandbox-core/fragment_detect/index.ts \
  packages/sandbox-core/fragment-detect-assist.test.mjs
git commit -m "feat(detect): questions for the Claude pass and the rules its answers must pass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The `sandbox detect` CLI command and the Agent SDK resolver

**Files:**
- Modify (rewrite): `apps/cli/src/commands/detect.ts`
- Create: `apps/cli/src/lib/assist_resolver.ts`
- Modify: `apps/cli/src/main.ts` (the `detect` entry, about lines 210–222, and the usage line in the header comment)
- Modify: `apps/cli/package.json`, `package-lock.json` (add the SDK)
- Modify: `apps/cli/esbuild.mjs` (`external`)
- Test: `apps/cli/src/lib/__tests__/detect_command.test.ts`

**Interfaces:**
- Consumes: `sandbox-core/fragment_detect` (Tasks 1–11), `getReposRoot`/`servicesLocalYamlPath` from `sandbox-core/config`, `RegistryError` from `sandbox-core/registry_sync`, `confirm` from `../lib/wizard.js`, and `Colors`/`info`/`success`/`warn` from `../lib/config.js`.
- Produces:
  - `DetectArgs = { repo: string | null; dryRun: boolean; yes: boolean; assist: boolean | undefined }`
  - `DetectDeps = { runner: Runner; resolver: Resolver; interactive: boolean; reposRoot: string; localPath: string; portsPerSlot: number; cwd: string }`
  - `runDetect(args, deps): Promise<number>` (the exit code)
  - `run(args)`, the command entry
  - `claudeResolver: Resolver`

- [ ] **Step 1: Add the SDK and mark it external**

Run: `npm install @anthropic-ai/claude-agent-sdk@^0.3.288 -w werkmeister`

In `apps/cli/esbuild.mjs`, change the `external` line to:

```js
  // The Agent SDK runs a bundled Claude Code binary it locates relative to its
  // own package, so it stays an installed dependency rather than bundled code.
  external: ["dockerode", "*.node", "@anthropic-ai/claude-agent-sdk"],
```

- [ ] **Step 2: Write the failing tests**

`apps/cli/src/lib/__tests__/detect_command.test.ts`:

```ts
/**
 * `sandbox detect` end to end through runDetect with injected tools, so
 * nothing shells out to git or helm and nothing talks to Claude.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Answer, Resolver } from "sandbox-core/fragment_detect";
import type { Runner } from "sandbox-core/machine_setup";
import { runDetect, type DetectDeps } from "../../commands/detect.js";

const noTools: Runner = (cmd) => (cmd[0] === "git" ? [128, "fatal: not a git repository"] : [127, `${cmd[0]}: command not found`]);

function repo(files: Record<string, string>): { root: string; reposRoot: string } {
  const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "detect-cmd-"));
  const root = path.join(reposRoot, "shop");
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { root, reposRoot };
}

const NODE_APP = {
  "package.json": JSON.stringify({ name: "shop", scripts: { dev: "node server.js", test: "node --test" }, dependencies: { express: "4" } }),
  "Dockerfile": "FROM node:22-alpine\nEXPOSE 8080\nCMD [\"node\", \"server.js\"]\n",
};
const GO_APP = { "services/api/Dockerfile": "FROM golang:1.23\nEXPOSE 9000\nCMD [\"/app/api\"]\n" };

function deps(reposRoot: string, over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    runner: noTools,
    resolver: async () => [],
    interactive: false,
    reposRoot,
    localPath: path.join(reposRoot, "no-local.yaml"),
    portsPerSlot: 20,
    cwd: reposRoot,
    ...over,
  };
}
const args = (over: Partial<{ repo: string | null; dryRun: boolean; yes: boolean; assist: boolean | undefined }> = {}) => ({
  repo: "shop", dryRun: false, yes: false, assist: undefined, ...over,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("sandbox detect", () => {
  it("--dry-run reports and writes nothing", async () => {
    const { root, reposRoot } = repo(NODE_APP);
    expect(await runDetect(args({ dryRun: true }), deps(reposRoot))).toBe(0);
    expect(fs.existsSync(path.join(root, ".sandbox/services.yaml"))).toBe(false);
  });

  it("without a TTY and without --yes it writes nothing", async () => {
    const { root, reposRoot } = repo(NODE_APP);
    expect(await runDetect(args(), deps(reposRoot))).toBe(0);
    expect(fs.existsSync(path.join(root, ".sandbox/services.yaml"))).toBe(false);
  });

  it("--yes writes a runnable fragment, and a second run is a no-op", async () => {
    const { root, reposRoot } = repo(NODE_APP);
    expect(await runDetect(args({ yes: true }), deps(reposRoot))).toBe(0);
    const file = path.join(root, ".sandbox/services.yaml");
    const first = fs.readFileSync(file, "utf8");
    expect(first).toContain("internal_port: 8080");
    expect(first).toContain("command: exec npm run dev");
    expect(first).toContain("shop-install:");
    expect(await runDetect(args({ yes: true }), deps(reposRoot))).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("--assist sends the guesses to the resolver and writes its answers as inferred", async () => {
    const { root, reposRoot } = repo(GO_APP);
    const resolver = vi.fn<Resolver>(async (_root, questions) => {
      expect(questions.map((q) => q.id)).toContain("api.command");
      return [{ item: "api.command", value: "cd services/api && exec go run .", reason: "README dev section", files_read: ["README.md"] } satisfies Answer];
    });
    expect(await runDetect(args({ yes: true, assist: true }), deps(reposRoot, { resolver }))).toBe(0);
    expect(resolver).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(root, ".sandbox/services.yaml"), "utf8")).toContain(
      "command: cd services/api && exec go run . # inferred by Claude: README dev section",
    );
  });

  it("a failing resolver keeps the deterministic guesses and still writes", async () => {
    const { root, reposRoot } = repo(GO_APP);
    const resolver: Resolver = async () => {
      throw new Error("not logged in");
    };
    expect(await runDetect(args({ yes: true, assist: true }), deps(reposRoot, { resolver }))).toBe(0);
    expect(fs.readFileSync(path.join(root, ".sandbox/services.yaml"), "utf8")).toContain("# guessed:");
  });

  it("--dry-run never calls the resolver, even with --assist", async () => {
    const { reposRoot } = repo(GO_APP);
    const resolver = vi.fn<Resolver>(async () => []);
    await runDetect(args({ dryRun: true, assist: true }), deps(reposRoot, { resolver }));
    expect(resolver).not.toHaveBeenCalled();
  });

  it("with no repo argument outside a git repo it exits 2", async () => {
    const { reposRoot } = repo(NODE_APP);
    expect(await runDetect(args({ repo: null }), deps(reposRoot))).toBe(2);
  });

  it("a repo with nothing to detect exits 1 and writes nothing", async () => {
    const { root, reposRoot } = repo({ "README.md": "hi" });
    expect(await runDetect(args({ yes: true }), deps(reposRoot))).toBe(1);
    expect(fs.existsSync(path.join(root, ".sandbox"))).toBe(false);
  });
});
```

- [ ] **Step 3: Build core and run the tests to verify they fail**

Run: `cd packages/sandbox-core && npx tsc && cd ../../apps/cli && npx vitest run src/lib/__tests__/detect_command.test.ts`
Expected: FAIL. `runDetect` isn't exported from `commands/detect.js`, which is still the old command.

- [ ] **Step 4: Write `assist_resolver.ts`**

```ts
/**
 * The Resolver behind `sandbox detect --assist`: one Claude Agent SDK session
 * over the repo, read-only, returning answers as structured output. Imported
 * lazily so the SDK loads only when the user opts in.
 */
import type { Answer, Question, Resolver } from "sandbox-core/fragment_detect";
import { ANSWER_SCHEMA, assistPrompt } from "sandbox-core/fragment_detect";

export const claudeResolver: Resolver = async (repoRoot: string, questions: Question[]): Promise<Answer[]> => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  for await (const message of query({
    prompt: assistPrompt(questions),
    options: {
      cwd: repoRoot,
      model: "claude-opus-5-5",
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk",
      maxTurns: 40,
      outputFormat: { type: "json_schema", schema: ANSWER_SCHEMA },
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype === "success" && message.structured_output) {
      return (message.structured_output as { answers: Answer[] }).answers;
    }
    throw new Error(`Claude returned no answers (${message.subtype})`);
  }
  throw new Error("the Claude session ended without a result");
};
```

If `tsc` rejects `ANSWER_SCHEMA` as the `schema` type, pass `ANSWER_SCHEMA as Record<string, unknown>`. Change nothing else: the field names are from the SDK's TypeScript reference (`query`, `options.cwd`, `model`, `tools`, `allowedTools`, `permissionMode: "dontAsk"`, `maxTurns`, and `outputFormat: { type: "json_schema", schema }`), and a successful result is `message.type === "result" && message.subtype === "success" && message.structured_output`.

- [ ] **Step 5: Rewrite `apps/cli/src/commands/detect.ts`**

```ts
/**
 * sandbox detect [repo] [--dry-run] [--yes] [--assist | --no-assist]
 *
 * Generate <repo>/.sandbox/services.yaml from what the repo already says about
 * itself: package manifests, Dockerfiles, compose, Helm, k8s and kustomize.
 * Re-runs only add what is missing. Spec:
 * docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md.
 */
import * as path from "node:path";

import { getReposRoot, servicesLocalYamlPath } from "sandbox-core/config";
import {
  AllocationError,
  applyAnswers,
  collectQuestions,
  planFragment,
  portsPerSlot,
  renderFragment,
  stdoutRunner,
  validateFragment,
  writeFragment,
  type FieldValue,
  type Plan,
  type Resolver,
} from "sandbox-core/fragment_detect";
import type { Runner } from "sandbox-core/machine_setup";
import { RegistryError } from "sandbox-core/registry_sync";

import { claudeResolver } from "../lib/assist_resolver.js";
import { Colors, info, success, warn } from "../lib/config.js";
import { confirm } from "../lib/wizard.js";

export interface DetectArgs {
  repo: string | null;
  dryRun: boolean;
  yes: boolean;
  /** true = --assist, false = --no-assist, undefined = ask when interactive. */
  assist: boolean | undefined;
}

export interface DetectDeps {
  runner: Runner;
  resolver: Resolver;
  interactive: boolean;
  reposRoot: string;
  localPath: string;
  portsPerSlot: number;
  cwd: string;
}

function mark(fv: FieldValue): string {
  return fv.confidence === "stated" ? "" : ` ${Colors.YELLOW}[${fv.confidence}]${Colors.RESET}`;
}

function printFields(fields: Record<string, FieldValue>): void {
  for (const [key, fv] of Object.entries(fields)) {
    console.log(`    ${key}: ${JSON.stringify(fv.value)}${mark(fv)}  ${Colors.DIM}${fv.source}${Colors.RESET}`);
  }
}

function printPlan(plan: Plan): void {
  for (const s of plan.services) {
    console.log(`\n  ${Colors.BOLD}${s.name}${Colors.RESET} ${Colors.DIM}(${s.dir})${Colors.RESET}`);
    printFields(s.fields);
  }
  for (const i of plan.infrastructure) {
    console.log(`\n  ${Colors.BOLD}${i.name}${Colors.RESET} ${Colors.DIM}(infrastructure)${Colors.RESET}`);
    printFields(i.fields);
  }
  if (plan.setup) {
    console.log(`\n  ${Colors.BOLD}${plan.setup.name}${Colors.RESET} ${Colors.DIM}(setup service)${Colors.RESET}`);
    printFields(plan.setup.fields);
  }
  const conflicts = plan.services.flatMap((s) => s.conflicts);
  if (conflicts.length) {
    console.log(`\n  ${Colors.BOLD}Conflicts${Colors.RESET}`);
    for (const c of conflicts) {
      const also = c.also.map((a) => `${JSON.stringify(a.value)} (${a.source})`).join(", ");
      console.log(`    ${c.service}.${c.key}: ${JSON.stringify(c.chosen.value)} (${c.chosen.source}) over ${also}`);
    }
  }
  if (plan.skipped.length) {
    console.log(`\n  ${Colors.BOLD}Skipped${Colors.RESET}`);
    for (const s of plan.skipped) console.log(`    ${s.item}: ${s.reason}`);
  }
}

export async function runDetect(args: DetectArgs, deps: DetectDeps): Promise<number> {
  let root: string;
  if (args.repo) {
    root = path.resolve(deps.cwd, args.repo);
  } else {
    const [rc, out] = deps.runner(["git", "-C", deps.cwd, "rev-parse", "--show-toplevel"]);
    if (rc !== 0) {
      warn("Not inside a git repo — pass the repo path: sandbox detect <repo>");
      return 2;
    }
    root = out.trim();
  }

  let plan: Plan;
  try {
    plan = planFragment(root, {
      reposRoot: deps.reposRoot,
      runner: deps.runner,
      localPath: deps.localPath,
      portsPerSlot: deps.portsPerSlot,
    });
  } catch (e) {
    if (e instanceof AllocationError || e instanceof RegistryError) {
      warn(e.message);
      return 1;
    }
    throw e;
  }

  console.log(`\n${Colors.BOLD}=== sandbox detect: ${plan.repo} ===${Colors.RESET}`);
  printPlan(plan);
  if (!plan.services.length && !plan.infrastructure.length) {
    warn(`No services found in ${root}.`);
    return 1;
  }

  const questions = collectQuestions(plan);
  if (questions.length && args.dryRun) {
    info(`${questions.length} field(s) are guesses; --assist would ask Claude about:`);
    for (const q of questions) console.log(`    ? ${q.id}: ${q.prompt}`);
  } else if (questions.length) {
    const ask =
      args.assist ??
      (await confirm(`  ${questions.length} field(s) are guesses — ask Claude to resolve them?`, false, deps.interactive));
    if (ask) {
      try {
        const result = applyAnswers(plan, await deps.resolver(plan.root, questions));
        plan = result.plan;
        for (const item of result.accepted) success(`Claude resolved ${item}`);
        for (const r of result.rejected) warn(`Ignored Claude's answer for ${r.item}: ${r.reason}`);
      } catch (e) {
        warn(`Claude pass failed (${e instanceof Error ? e.message : String(e)}) — keeping the deterministic guesses.`);
      }
    }
  }

  const rendered = renderFragment(plan);
  if (!rendered.changed) {
    success(`${rendered.path} is up to date — nothing to add.`);
    return 0;
  }
  const errors = validateFragment(rendered, plan, deps.reposRoot);
  if (errors.length) {
    for (const e of errors) warn(e);
    warn("Not written: the generated fragment failed validation.");
    return 1;
  }
  console.log(plan.existing === null ? `\n${rendered.yaml}` : `\n  Would add: ${rendered.added.join(", ")}`);

  if (args.dryRun) return 0;
  if (!args.yes && !deps.interactive) {
    info("Not a TTY — nothing written (pass --yes to write).");
    return 0;
  }
  if (!args.yes && !(await confirm(`  Write ${rendered.path}?`, false, deps.interactive))) {
    info("Nothing written.");
    return 0;
  }
  writeFragment(rendered);
  success(`Wrote ${rendered.path}`);
  if (rendered.added.some((a) => a.endsWith(".port_offset"))) {
    info("port_offset is machine-wide — a collision on another machine shows up at `sandbox registry sync`.");
  }
  info("next: sandbox registry sync");
  return 0;
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const code = await runDetect(
    {
      repo: (args.repo as string | null) ?? null,
      dryRun: Boolean(args.dryRun),
      yes: Boolean(args.yes),
      assist: args.assist as boolean | undefined,
    },
    {
      runner: stdoutRunner,
      resolver: claudeResolver,
      interactive: Boolean(process.stdin.isTTY),
      reposRoot: getReposRoot(),
      localPath: servicesLocalYamlPath(),
      portsPerSlot: portsPerSlot(),
      cwd: process.cwd(),
    },
  );
  if (code) process.exit(code);
}
```

- [ ] **Step 6: Re-register the command**

In `apps/cli/src/main.ts`, replace the whole `detect` entry (the object with `name: "detect"`) with:

```ts
  {
    name: "detect",
    load: () => import("./commands/detect.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Generate <repo>/.sandbox/services.yaml from the repo's package manifests, " +
            "Dockerfiles, compose, Helm and k8s files (re-runs only add what is missing)",
        )
        .argument("[repo]", "Repo directory (default: the git repo containing the current directory)")
        .option("--dry-run", "Show the report and the proposed YAML; write nothing")
        .option("-y, --yes", "Write without asking")
        .option("--assist", "Ask Claude to resolve the fields the scan had to guess")
        .option("--no-assist", "Never ask Claude");
    },
    namespace: ([repo], o) => ({ repo: repo ?? null, dryRun: Boolean(o.dryRun), yes: Boolean(o.yes), assist: o.assist }),
  },
```

In the usage block at the top of `main.ts`, replace line 16 (`sandbox detect <feature>   Analyse worktrees for changed services`) with:

```
 *     sandbox detect [repo] [--dry-run] [--yes] [--assist|--no-assist]  Generate a repo's .sandbox/services.yaml
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/cli && npx tsc --noEmit -p . && npx vitest run src/lib/__tests__/detect_command.test.ts`
Expected: typecheck clean, then PASS, 8 tests.

- [ ] **Step 8: Check the bundle loads without the SDK being touched**

Run: `cd apps/cli && node esbuild.mjs && node dist/main.js detect --help`
Expected: help text listing `--dry-run`, `--yes`, `--assist` and `--no-assist`. The SDK is only imported inside `claudeResolver`.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/commands/detect.ts apps/cli/src/lib/assist_resolver.ts apps/cli/src/main.ts \
  apps/cli/src/lib/__tests__/detect_command.test.ts apps/cli/package.json apps/cli/esbuild.mjs package-lock.json
git commit -m "feat(cli): sandbox detect generates a repo's registry fragment

Replaces the changed-service detect command. --assist asks Claude (Agent SDK,
read-only tools) about the fields the scan had to guess.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Repurpose the `sandbox-detect` MCP tool and delete the old detection

**Files:**
- Modify: `apps/mcp/tools.ts` (imports at lines 15–44, and the `sandbox-detect` registration at lines 203–228)
- Delete: `packages/sandbox-core/detect.ts`
- Delete: `packages/sandbox-core/detect-report.test.mjs`
- Modify: `packages/sandbox-core/package.json` (remove the `"./detect"` export)

**Interfaces:**
- Consumes: `planFragment`, `planSummary`, `renderFragment`, `validateFragment`, `writeFragment`, `collectQuestions`, `applyAnswers`, `portsPerSlot`, `stdoutRunner` from `sandbox-core/fragment_detect`, and `getReposRoot`/`servicesLocalYamlPath` from `sandbox-core/config`.
- Produces: an MCP tool `sandbox-detect` with input `{ repo: string; write?: boolean; answers?: Answer[] }`, returning `structuredContent` `{ path, wrote, changed, added, errors, yaml, report, questions, accepted, rejected }`.

There's no MCP tool test harness in this repo. The tool body is glue over functions Tasks 1–11 test; this task is verified by typecheck, the bundle test and one manual call.

- [ ] **Step 1: Confirm nothing else uses the old module**

Run: `grep -rn "sandbox-core/detect\"\|detectReport\|detectChangedServices" apps packages --include=*.ts --include=*.mjs | grep -v node_modules | grep -v /dist/`
Expected: matches only in `apps/mcp/tools.ts`, `packages/sandbox-core/detect.ts` and `packages/sandbox-core/detect-report.test.mjs`.

- [ ] **Step 2: Replace the imports in `apps/mcp/tools.ts`**

Delete:

```ts
import { detectReport } from "sandbox-core/detect";
```

Change `import { sandboxRoot } from "sandbox-core/config";` to:

```ts
import { getReposRoot, sandboxRoot, servicesLocalYamlPath } from "sandbox-core/config";
```

Add, next to the other `sandbox-core/*` imports:

```ts
import {
  applyAnswers,
  collectQuestions,
  planFragment,
  planSummary,
  portsPerSlot,
  renderFragment,
  stdoutRunner,
  validateFragment,
  writeFragment,
} from "sandbox-core/fragment_detect";
```

Add at the top of the import block:

```ts
import * as path from "node:path";
```

- [ ] **Step 3: Replace the tool registration**

Replace the whole `server.registerTool("sandbox-detect", …)` call with:

```ts
  server.registerTool(
    "sandbox-detect",
    {
      title: "Generate a repo's service-registry fragment",
      description:
        "Scan a repo (package manifests, Dockerfiles, compose, Helm, k8s, kustomize) and propose its " +
        ".sandbox/services.yaml. Returns the report, the proposed YAML and the questions the scan could " +
        "not settle. Writes only with write: true. Answer questions by passing `answers` " +
        "({ item: <question id>, value, reason, files_read }); answers can only fill those questions.",
      inputSchema: {
        repo: z.string().describe("Repo directory name under paths.repos_root, or an absolute path."),
        write: z.boolean().optional().describe("Write the fragment when it is valid and something changed."),
        answers: z
          .array(
            z.object({
              item: z.string(),
              value: z.unknown(),
              reason: z.string(),
              files_read: z.array(z.string()).default([]),
            }),
          )
          .optional(),
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => {
        const reposRoot = getReposRoot();
        const root = path.isAbsolute(args.repo) ? args.repo : path.join(reposRoot, args.repo);
        let plan = planFragment(root, {
          reposRoot,
          runner: stdoutRunner,
          localPath: servicesLocalYamlPath(),
          portsPerSlot: portsPerSlot(),
        });
        const applied = args.answers?.length ? applyAnswers(plan, args.answers) : null;
        if (applied) plan = applied.plan;
        const rendered = renderFragment(plan);
        const errors = rendered.changed ? validateFragment(rendered, plan, reposRoot) : [];
        const wrote = Boolean(args.write) && rendered.changed && errors.length === 0;
        if (wrote) writeFragment(rendered);
        return {
          path: rendered.path,
          wrote,
          changed: rendered.changed,
          added: rendered.added,
          errors,
          yaml: rendered.yaml,
          report: planSummary(plan),
          questions: collectQuestions(plan),
          accepted: applied?.accepted ?? [],
          rejected: applied?.rejected ?? [],
        };
      }),
  );
```

If `resolveWorkspaceDir` is now unused in `tools.ts`, remove it from the `./lib/feature.js` import. Run `grep -n resolveWorkspaceDir apps/mcp/tools.ts` to check.

- [ ] **Step 4: Delete the old detection**

```bash
git rm packages/sandbox-core/detect.ts packages/sandbox-core/detect-report.test.mjs
```

In `packages/sandbox-core/package.json`, delete the line `"./detect": "./dist/detect.js",`.

- [ ] **Step 5: Typecheck and run the suites**

Run: `cd packages/sandbox-core && npm test`
Expected: PASS. The `detect-report` tests are gone and the `fragment-detect-*` tests pass.

Run: `cd apps/mcp && npx tsc --noEmit`
Expected: no errors.

Run: `cd apps/cli && npm test`
Expected: all test files PASS, including `src/__tests__/mcp_bundle.test.ts`, which proves `dist/mcp.js` still answers `initialize` with the SDK external.

- [ ] **Step 6: Manual check of the tool**

Run (from the repo root): `node apps/cli/dist/main.js detect "$HOME/repos/demo-services" --dry-run --no-assist`
Expected: a report for `backend`, `frontend`, `redis`, `postgres` and `demo-install`, ending with either `… is up to date — nothing to add.` or a `Would add:` list. This exercises the same core calls the MCP tool makes.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp/tools.ts packages/sandbox-core/package.json
git commit -m "feat(mcp): sandbox-detect proposes and writes a repo's registry fragment

Removes the changed-service detection it used to expose; nothing else used it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Docs and the acceptance check against real repos

**Files:**
- Modify: `docs/users-guide.md`, in four places:
  - table of contents, about line 25
  - "Service Auto-Detection", about lines 249–262
  - "### sandbox detect", about lines 484–500
  - "Services Not Auto-Detected", about line 1552
- Modify: `docs/users-guide.md`, the "Writing a fragment" section (about line 853): add a pointer to `sandbox detect`
- Modify: `docs/known-issues.md:542` (drop `detectReport` from the list of registry-reaching functions)
- Modify: `.changeset/` (new file)

**Interfaces:**
- Consumes: the finished command.
- Produces: docs only, plus an acceptance report in the final hand-off message.

- [ ] **Step 1: Rewrite the `### sandbox detect` section**

Replace the section's body, from the heading to the next `---`, with:

````markdown
### sandbox detect

**Generate a repo's `.sandbox/services.yaml` from what the repo already contains.**

```
sandbox detect [repo] [--dry-run] [--yes] [--assist | --no-assist]
```

| Argument | Description |
|---|---|
| `repo` | Repo directory. Default: the git repo containing the current directory. |
| `--dry-run` | Print the report and the proposed YAML; write nothing. |
| `--yes`, `-y` | Write without asking. |
| `--assist` / `--no-assist` | Ask Claude about the fields the scan had to guess, or never ask. Without either flag an interactive run asks first (default no), and a non-interactive run never asks. |

It reads `package.json` and workspaces (npm, pnpm, yarn), Dockerfiles, docker-compose files, Helm charts (rendered with `helm template`), raw k8s manifests and kustomize overlays (`kubectl kustomize`). For each value the report shows where it came from, and every guess is marked. Guesses are written with a `# guessed:` comment, so they're easy to find and fix.

`port_offset` is picked from the offsets no other repo under `paths.repos_root` uses. Infrastructure (redis, postgres and other datastores) gets the next free `k8s_forward_port` from 9050.

Re-running only adds services and keys the file doesn't have yet. Nothing already in the file changes: not values, comments or formatting. After writing, run `sandbox registry sync`.

`--assist` runs one read-only Claude session (Read, Glob and Grep only) over the repo. It only answers the listed questions: a non-Node service's dev command, health path, environment, secrets, `depends_on`, and which service an unmatched Deployment belongs to. Answers are written with `# inferred by Claude:` and never replace a value the scan read from a file.
````

- [ ] **Step 2: Fix the other references**

- **Table of contents:** keep the `[sandbox detect](#sandbox-detect)` link as it is.
- **"Service Auto-Detection":** replace the whole section (heading through the example) with:

  ```markdown
  ### Which services run locally

  `sandbox up` runs the services listed in the workspace's `.sandbox/workspace.yml` `services:` key (or passed with `-s`). Everything else is reached in the cluster through the k8s-forwards tunnels.
  ```

- **"Services Not Auto-Detected":** delete the `./sandbox detect PROJ-1234` line and the comment above it. Keep the `git diff` lines.
- **"Writing a fragment":** append this sentence to its first paragraph: `` `sandbox detect` writes a first draft of this file for you; see [sandbox detect](#sandbox-detect). ``
- **`docs/known-issues.md:542`:** remove `` `detectReport`, `` from the list.

- [ ] **Step 3: Add a changeset**

`.changeset/sandbox-detect-fragments.md`:

```markdown
---
"werkmeister": minor
---

`sandbox detect` now generates a repo's `.sandbox/services.yaml` from its package manifests, Dockerfiles, docker-compose files, Helm charts, k8s manifests and kustomize overlays, and re-runs only add what is missing. `--assist` asks Claude about the fields the scan had to guess. The old changed-service report is gone; the `sandbox-detect` MCP tool now returns the proposed fragment and writes it with `write: true`.
```

Check the package name first: `node -e 'console.log(require("./apps/cli/package.json").name)'`. Use whatever it prints.

- [ ] **Step 4: Acceptance check against the real repos**

Run:

```bash
ACC=$(mktemp -d)
for r in demo-services mobile-app; do
  rsync -a --exclude node_modules --exclude .git ~/repos/$r/ "$ACC/$r/"
  mv "$ACC/$r/.sandbox/services.yaml" "$ACC/$r.hand.yaml"
  node apps/cli/dist/main.js detect "$ACC/$r" --dry-run --no-assist > "$ACC/$r.detect.txt" 2>&1
done
echo "$ACC"
```

The checks run on copies with the hand fragment removed, so `detect` produces a fresh file (the comparison the spec asks for) and the real repos are never touched. `port_offset`s will differ, because the real fragments under `repos_root` still count as taken; that's expected.

For each repo, compare the YAML printed in `$ACC/<repo>.detect.txt` with `$ACC/<repo>.hand.yaml`, service by service:

- **Must match** (everything a file states): `path`, `internal_port`, `health_endpoint`, `image`, `k8s_deployment`, `k8s_namespace`, `k8s_port`, `k8s_port_name`, `k8s_pod_prefix`, and each infrastructure entry's `internal_port`, `k8s_namespace`, `k8s_pod_prefix` and `health_endpoint`.
- **May differ** (judgement fields): `command` wording, `test`, `environment` beyond the `DATABASE_URL` rewrite, `secrets`, `memory_*`, `port_offset`, `k8s_forward_port`, `setup_service` naming, `depends_on`, `feature_router`, and comments.

A must-match difference is a bug: fix it in the owning task's module, add a test for it there, and re-run. Record every may-differ difference for the hand-off message.

Then confirm gap-filling on the real files changes nothing:

Run: `node apps/cli/dist/main.js detect ~/repos/demo-services --dry-run --no-assist | tail -3`
Expected: `… is up to date — nothing to add.`, or a `Would add:` list containing only keys the hand fragment omits. Record which.

- [ ] **Step 5: Full verification**

Run: `cd packages/sandbox-core && npm test && cd ../../apps/cli && npm test && cd ../mcp && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/users-guide.md docs/known-issues.md .changeset/sandbox-detect-fragments.md
git commit -m "docs: sandbox detect generates registry fragments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
