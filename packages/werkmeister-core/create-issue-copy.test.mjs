// A create (initWorkspace handed the fetched snapshot) writes .werkmeister/issue.md
// and the issue section, per strategy; a later re-init never seeds a JIT handoff
// from the issue alone (spec §6).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { issueCopyPath } from "./dist/issue_snapshot.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const REPO = path.resolve(import.meta.dirname, "..", "..");
process.env.WERKMEISTER_ROOT = path.join(REPO, "apps", "cli");

const SNAP = {
  ref: "o/r#5",
  url: "https://github.com/o/r/issues/5",
  tracker: "github",
  title: "Stale config",
  status: "OPEN",
  body: "The config goes stale.",
  comments: [],
  fetchedAt: "2026-10-11T18:04:00.000Z",
};

function walk(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out.sort();
}

/** A fresh workspace dir with workspace.yml; runs fn(root) under a GitHub-tracker sandbox home. */
async function withWorkspace(yml, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-copy-ws-"));
  try {
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(path.join(root, ".werkmeister", "workspace.yml"), yml);
    return await withSandboxHome(() => withReporter(collectingReporter(), () => fn(root)), {
      config: "overrides:\n  issue_tracker: github\n",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const notes = (root) => {
  const dir = path.join(root, ".werkmeister", "notes");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
};

for (const strategy of ["jit", "icm"]) {
  test(`${strategy}: a create writes the issue copy and the issue section`, async () => {
    await withWorkspace(
      `task: Fix it\nwork_type: bugfix\ncontext_strategy: ${strategy}\nissue_id: o/r#5\n`,
      async (root) => {
        await initWorkspace({}, root, { issue: SNAP });
        assert.ok(fs.existsSync(issueCopyPath(root)));
        assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /^## Issue$/m);
      },
    );
  });
}

test("jit: a create with an issue and no prompt seeds a handoff without 'task below' text", async () => {
  await withWorkspace("task: Fix it\nwork_type: bugfix\nissue_id: o/r#5\n", async (root) => {
    await initWorkspace({}, root, { issue: SNAP });
    const [note] = notes(root);
    const body = fs.readFileSync(path.join(root, ".werkmeister", "notes", note), "utf8");
    assert.match(body, /^## Issue$/m);
    assert.doesNotMatch(body, /task below|Seeded from `starting_prompt`/);
  });
});

test("jit: re-init with an issue but no prompt and no handed-over snapshot seeds nothing", async () => {
  await withWorkspace("task: Fix it\nwork_type: bugfix\nissue_id: o/r#5\n", async (root) => {
    await initWorkspace({}, root);
    assert.deepEqual(notes(root), []);
  });
});

test("jit: the same create twice gives byte-identical files", async () => {
  const run = () =>
    withWorkspace(
      "task: Fix it\nwork_type: bugfix\nissue_id: o/r#5\nstarting_prompt: Fix the stale config.\n",
      async (root) => {
        await initWorkspace({}, root, { issue: SNAP });
        // The daemon token is random by design (SW-184); every other file must repeat.
        return Object.fromEntries(
          walk(root)
            .filter((f) => f !== path.join(".werkmeister", "token"))
            .map((f) => [
              f,
              fs
                .readFileSync(path.join(root, f), "utf8")
                .replace(/create-copy-ws-[A-Za-z0-9]+/g, "<WS>")
                .replaceAll(os.tmpdir(), "<TMP>"),
            ]),
        );
      },
    );
  assert.deepEqual(await run(), await run());
});
