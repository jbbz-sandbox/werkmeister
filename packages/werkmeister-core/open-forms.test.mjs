// openForms (SW-309): the /workspaces pane's Questions tab — open forms across the
// workspaces the check-in label filter keeps, without marking a check-in.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "open-forms-home-"));
const root = path.join(home, "features");
process.env.HOME = home;
process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";
process.env.WERKMEISTER_WORKSPACES_ROOT = root;

const { openForms, formHash } = await import("./dist/sandbox.js");

const FORM = (status) =>
  `# Q\n\n## Pick one\n\nstatus: ${status}\n\n- (x) a (recommended)\n- ( ) b\n`;

function workspace(name, files, labels = []) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".werkmeister", "workspace.yml"),
    `labels: [${labels.join(", ")}]\n`,
  );
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

test("lists proposed forms in kept workspaces only, and never marks a check-in", async () => {
  workspace("ws-open", {
    "stages/01_research/output/decisions.md": FORM("proposed"),
    "stages/02_spec/output/question-approval.md": FORM("decided"),
    // A gate line with no `## ` question is the courier's, not the tab's.
    "stages/02_spec/output/plan.md": "status: proposed\n",
  });
  workspace("ws-skipped", { "stages/01_research/output/decisions.md": FORM("proposed") }, ["skip"]);

  const forms = await openForms();
  assert.deepEqual(
    forms.map((f) => [f.workspace, f.rel]),
    [["ws-open", "stages/01_research/output/decisions.md"]],
  );
  const [f] = forms;
  assert.equal(f.hash, formHash(f.md));
  assert.equal(f.path, path.join(root, "ws-open", "stages/01_research/output/decisions.md"));
  assert.deepEqual(f.draft, { q1: { picked: ["a"], boxes: {} } });
  assert.equal(fs.existsSync(path.join(root, ".check-in-last")), false);
});
