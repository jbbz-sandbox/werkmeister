// An icm workspace's decisions are the `status: decided` lines in its stage
// outputs; graduation reads them through the strategy and scaffolds them with
// the same graduateNote path jit notes use (SW-72).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { graduateNote, reconcileGraduating } from "./dist/graduate.js";
import { strategyById } from "./dist/strategies/index.js";

const icm = strategyById("icm").decisions;
let tmp, ws, std;

const git = (...args) => execFileSync("git", ["-C", std, ...args], { stdio: "ignore" });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "icm-grad-"));
  ws = path.join(tmp, "ws");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  std = path.join(tmp, "standards");
  fs.mkdirSync(path.join(std, "widgets"), { recursive: true });
  fs.writeFileSync(
    path.join(std, "widgets", "STANDARD.md"),
    '---\ndomain: widgets\nsummary: Widget rules\napplies_to: ["**/*.widget.ts"]\n---\n\n' +
      "# Widgets\n\n## Rules\n\n- Something\n\n## Don't\n\n- Not that\n",
  );
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("no stage outputs: nothing to offer, nothing to reconcile", () => {
  assert.deepEqual(icm.open(ws), []);
  assert.deepEqual(reconcileGraduating(ws, std, icm), []);
});

test("decided sections are decisions; proposed ones, code blocks and frontmatter are not", () => {
  write(
    "stages/01_research/output/decisions.md",
    "# Decisions\n\n## Which store?\n\nstatus: decided\n\nUse sqlite.\n\n" +
      "## Which port?\n\nstatus: proposed\n\n## Example\n\n```\nstatus: decided\n```\n",
  );
  write("stages/04_propose/output/pr-sandbox.md", "---\nstatus: decided\n---\n\n# PR\n");
  write("stages/01_reproduce/output/repro.md", "status: decided\n\nNo heading above.\n");

  const open = icm.open(ws);
  assert.deepEqual(
    open.map((d) => [path.relative(ws, d.path), d.number, d.frontmatter.status]),
    [
      ["stages/01_reproduce/output/repro.md#repro", 1, "decided"],
      ["stages/01_research/output/decisions.md#which-store", 2, "decided"],
    ],
  );
  assert.match(open[1].body, /Use sqlite/);
  assert.doesNotMatch(open[1].body, /Which port/);
});

test("graduate → graduating → graduated, recorded beside the stage outputs", () => {
  write("stages/01_reproduce/output/repro.md", "## Proposed fix\n\nstatus: decided\n\nSize it.\n");
  const [decision] = icm.open(ws);

  const result = graduateNote(ws, decision, {
    domain: "widgets",
    kind: "example",
    standardsDir: std,
    decisions: icm,
  });
  const scaffold = fs.readFileSync(result.scaffold_path, "utf8");
  assert.match(
    scaffold,
    /TODO\(graduate\): fill from decision 001, see stages\/01_reproduce\/output\/repro\.md#proposed-fix/,
  );
  // The stage output is the run's record: graduation never rewrites it.
  assert.equal(
    fs.readFileSync(path.join(ws, "stages/01_reproduce/output/repro.md"), "utf8"),
    "## Proposed fix\n\nstatus: decided\n\nSize it.\n",
  );
  const [graduating] = icm.open(ws);
  assert.equal(graduating.frontmatter.status, "graduating");
  assert.equal(graduating.frontmatter.graduated_to, "widgets/references/proposed-fix.md");

  // Not tracked yet: stays open.
  assert.deepEqual(reconcileGraduating(ws, std, icm), []);
  git("add", "-A");
  assert.equal(reconcileGraduating(ws, std, icm).length, 1);
  assert.deepEqual(icm.open(ws), []);
});
