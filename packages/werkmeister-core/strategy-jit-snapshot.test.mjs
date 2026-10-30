// Every file JIT init writes, captured on `main` before the context-strategy
// move and asserted byte-for-byte after it (spec §5 test 5). Regenerate only
// when a JIT output change is intended: UPDATE_SNAPSHOT=1.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { withSandboxHome } from "./fixtures.mjs";

const SNAPSHOT = path.join(import.meta.dirname, "strategy-jit.snapshot.json");
const REPO = path.resolve(import.meta.dirname, "..", "..");
// Skill templates come from $WERKMEISTER_ROOT/infra/skills; a developer's shell
// often points it at another checkout. Pin it to this one.
process.env.WERKMEISTER_ROOT = path.join(REPO, "apps", "cli");

function walk(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(root, child));
    else out.push(child);
  }
  return out.sort();
}

function seedStandards(dir) {
  fs.mkdirSync(path.join(dir, "comments"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "comments", "STANDARD.md"),
    '---\ndomain: comments\nuniversal: 1\napplies_to:\n  - "**/*"\nphase: [implement]\nsummary: Comments explain why.\n---\n\n# Comments\n',
  );
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ui", "STANDARD.md"),
    '---\ndomain: ui\napplies_to:\n  - "**/*.tsx"\nphase: [implement]\nsummary: UI rules.\n---\n\n# UI\n',
  );
}

test("jit init writes the same files, byte for byte", async () => {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "jit-snap-std-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jit-snap-ws-"));
  try {
    seedStandards(std);
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(
      path.join(root, ".werkmeister", "workspace.yml"),
      "task: Snapshot run\nwork_type: feature\nstarting_prompt: Add a health check.\n",
    );
    const files = await withSandboxHome(
      async (home) => {
        await withReporter(collectingReporter(), () => initWorkspace({}, root));
        const out = {};
        for (const rel of walk(root)) {
          // The daemon token is random by design (SW-184).
          if (rel === path.join(".werkmeister", "token")) continue;
          out[rel] = fs
            .readFileSync(path.join(root, rel), "utf8")
            .replaceAll(root, "<ROOT>")
            .replaceAll(std, "<STD>")
            .replaceAll(home, "<HOME>")
            .replaceAll(REPO, "<REPO>")
            .replaceAll(os.homedir(), "<USERHOME>")
            .replace(/jit-snap-ws-[a-zA-Z0-9]+/g, "<WORKSPACE>");
        }
        return out;
      },
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
    if (process.env.UPDATE_SNAPSHOT) {
      fs.writeFileSync(SNAPSHOT, JSON.stringify(files, null, 2) + "\n");
    }
    assert.deepEqual(files, JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});
