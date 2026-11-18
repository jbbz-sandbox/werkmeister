// SW-646: generic contracts take a managed repo's commands from its config, never werkmeister's toolchain.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const pythonRegistry = (repo) => `services:
  lib: { type: library, repo: app, path: packages/lib, test: "uv run pytest" }
repos:
  app: { services: [lib]${repo} }
`;

/** Every markdown file init writes for this registry, not the code repo (SW-651: _shared, CLAUDE.md, skills too). */
const generated = (services, workspace, prefix) =>
  withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      return fs
        .readdirSync(fx.workspace, { recursive: true })
        .filter((f) => f.endsWith(".md") && !/^(app|\.git)(\/|$)/.test(f))
        .map((f) => [prefix + f, fs.readFileSync(path.join(fx.workspace, f), "utf8")]);
    },
    { services, workspace },
  );

// An icm workspace gets stages and _shared but no skills; only jit projects the w9r-* skills.
const contracts = async (services) =>
  Object.fromEntries([
    ...(await generated(services, { context_strategy: "icm" }, "")),
    ...(await generated(services, {}, "jit:")),
  ]);

const TOOLCHAIN = /\b(pnpm|biome|turbo|changesets?)\b/i;
// Changesets-only behaviour, qualified as such; matched whole so a new mention still fails.
const QUALIFIED = [
  "`none` for a merged skip_release PR with no changeset (changesets repos)",
  "`pr status` writes `release: none` (changesets repos only; elsewhere set it yourself beside `skip_release`)",
];
const unqualified = (text) =>
  QUALIFIED.reduce((t, s) => t.split(s).join(""), text.replace(/\s+/g, " "));
const isContract = (f) => f.endsWith("CONTEXT.md") || f.endsWith("werkmeister-context.md");

test("a Python repo that declares nothing gets generated files with no werkmeister toolchain and no format step", async () => {
  const files = await contracts(pythonRegistry(""));
  assert.ok(
    Object.keys(files).some((f) => f.endsWith("SKILL.md")),
    Object.keys(files).join("\n"),
  );
  assert.ok(
    Object.keys(files).some((f) => f.startsWith("_shared")),
    Object.keys(files).join("\n"),
  );
  for (const [f, text] of Object.entries(files)) {
    assert.doesNotMatch(unqualified(text), TOOLCHAIN, f);
    if (isContract(f)) assert.doesNotMatch(text, /Format: `/, f);
  }
  const implement = Object.keys(files).find((f) => /_implement\b/.test(f));
  assert.match(files[implement], /format command/);
});

test("a Python repo's declared format and release check reach werkmeister-context.md", async () => {
  const files = await contracts(
    pythonRegistry(
      ', format: "uv run ruff format {files}", ship: tag, release_tag: "v*", release_check: "uv run towncrier check"',
    ),
  );
  for (const [f, text] of Object.entries(files))
    assert.doesNotMatch(unqualified(text), TOOLCHAIN, f);
  const ctx = files[path.join(".werkmeister", "werkmeister-context.md")];
  assert.match(
    ctx,
    /Format: `uv run ruff format \{files\}` — `\{files\}` replaced with the files you touched/,
  );
  assert.match(ctx, /Release check: `uv run towncrier check`/);
});

test("a format command without {files} is run as written", async () => {
  const files = await contracts(pythonRegistry(', format: "./gradlew spotlessApply"'));
  assert.match(
    files[path.join(".werkmeister", "werkmeister-context.md")],
    /Format: `\.\/gradlew spotlessApply` — run as written, from the repo root/,
  );
});
