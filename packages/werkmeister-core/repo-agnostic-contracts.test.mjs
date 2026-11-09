// SW-646: generic contracts take a managed repo's commands from its config, never werkmeister's toolchain.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const pythonRegistry = (repo) => `services:
  lib: { type: library, repo: app, path: packages/lib, test: "uv run pytest" }
repos:
  app: { services: [lib]${repo} }
`;

/** Every stage contract plus werkmeister-context.md of an icm fixture for this registry. */
const contracts = (services) =>
  withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const stages = path.join(fx.workspace, "stages");
      return Object.fromEntries(
        [
          ...fs.readdirSync(stages).map((d) => path.join("stages", d, "CONTEXT.md")),
          path.join(".werkmeister", "werkmeister-context.md"),
        ].map((f) => [f, fs.readFileSync(path.join(fx.workspace, f), "utf8")]),
      );
    },
    { services, workspace: { context_strategy: "icm" } },
  );

const TOOLCHAIN = /\b(pnpm|biome|turbo|changesets?)\b/i;

test("a Python repo that declares nothing gets contracts with no werkmeister toolchain and no format step", async () => {
  const files = await contracts(pythonRegistry(""));
  for (const [f, text] of Object.entries(files)) {
    assert.doesNotMatch(text, TOOLCHAIN, f);
    assert.doesNotMatch(text, /Format: `/, f);
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
  for (const [f, text] of Object.entries(files)) assert.doesNotMatch(text, TOOLCHAIN, f);
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
