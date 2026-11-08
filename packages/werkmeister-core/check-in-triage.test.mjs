// checkInTriage: the check-in skill's step 1 as one call — label filter,
// proposed gates, transcripts moved since the last check-in, candidates.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { writeSessionState } from "./fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "check-in-home-"));
const root = path.join(home, "features");
process.env.HOME = home;
process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";
process.env.WERKMEISTER_WORKSPACES_ROOT = root;

const { checkInTriage } = await import("./dist/sandbox.js");

function workspace(name, { labels = [], gate, lastRole } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".werkmeister", "workspace.yml"),
    `labels: [${labels.join(", ")}]\n`,
  );
  const out = path.join(dir, "stages", "02_plan", "output");
  fs.mkdirSync(out, { recursive: true });
  // Quoting the phrase in prose is not a gate; only a line starting with it is.
  fs.writeFileSync(path.join(out, "notes.md"), "Set `status: proposed` when done.\n");
  if (gate) fs.writeFileSync(path.join(out, "plan.md"), `---\nstatus: ${gate}\n---\n`);
  if (lastRole) say(dir, lastRole);
}

function say(dir, role) {
  const project = path.join(home, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(project, { recursive: true });
  const line = {
    type: role,
    message: { role, content: "hi" },
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(project, "s1.jsonl"), `${JSON.stringify(line)}\n`);
}

const names = (r) => r.workspaces.map((w) => w.name);

test("first run: skip dropped, gates read, candidates are where Claude spoke last or a gate waits", async () => {
  workspace("a-gate", { gate: "proposed" });
  workspace("b-decided", { gate: "decided", lastRole: "user" });
  workspace("c-waiting", { lastRole: "assistant" });
  workspace("d-parked", { labels: ["skip"], gate: "proposed" });
  // SW-559: a notice reads as needs-you, but a courier can't carry it, so alone it is no candidate.
  workspace("e-notice", { lastRole: "user" });
  fs.writeFileSync(
    path.join(root, "e-notice", ".werkmeister", "notices.json"),
    JSON.stringify({ n1: { what: "Gate failed", action: "Look", at: new Date().toISOString() } }),
  );

  const r = await checkInTriage();
  assert.equal(r.root, root);
  assert.equal(r.since, null);
  assert.deepEqual(names(r), ["a-gate", "b-decided", "c-waiting", "e-notice"]);
  assert.equal(r.workspaces[3].claude.agent, "needs-you");
  assert.deepEqual(r.dropped, ["d-parked"]);
  assert.deepEqual(r.workspaces[0].gates, [path.join("stages", "02_plan", "output", "plan.md")]);
  assert.deepEqual(r.workspaces[1].gates, []);
  assert.ok(r.workspaces.every((w) => !w.changed));
  // SW-487: a proposed gate is a needs-you item, so it is a candidate on the first run too.
  assert.deepEqual(r.candidates, ["a-gate", "c-waiting"]);
  assert.deepEqual(
    r.workspaces[0].workspaceState.needs.map((n) => n.kind),
    ["gate"],
  );
  assert.ok(fs.existsSync(path.join(root, ".check-in-last")));
});

test("next run: gates and transcripts that moved since the mark", async () => {
  // Back-date the mark so the write below is strictly newer.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(root, ".check-in-last"), past, past);
  for (const name of ["c-waiting", "e-notice"])
    fs.utimesSync(
      path.join(
        home,
        ".claude",
        "projects",
        path.join(root, name).replace(/[^a-zA-Z0-9]/g, "-"),
        "s1.jsonl",
      ),
      past,
      past,
    );
  say(path.join(root, "b-decided"), "assistant");

  const r = await checkInTriage();
  assert.equal(r.since, past.toISOString());
  assert.deepEqual(
    r.workspaces.map((w) => [w.name, w.changed]),
    [
      ["a-gate", false],
      ["b-decided", true],
      ["c-waiting", false],
      ["e-notice", false],
    ],
  );
  assert.deepEqual(r.candidates, ["a-gate", "b-decided"]);
});

test("focus narrows the sweep to focus workspaces", async () => {
  workspace("f-focus", { labels: ["focus"] });
  const r = await checkInTriage();
  assert.deepEqual(names(r), ["f-focus"]);
  assert.deepEqual(r.dropped, ["a-gate", "b-decided", "c-waiting", "d-parked", "e-notice"]);
});

test("the mark's sub-millisecond mtime rounds instead of truncating", async () => {
  // .8886s is 888.6ms: truncation would report ...888Z, the nearest ms is ...889Z.
  fs.utimesSync(path.join(root, ".check-in-last"), 1_700_000_000.8886, 1_700_000_000.8886);
  const r = await checkInTriage();
  assert.equal(r.since, new Date(1_700_000_000_889).toISOString());
});

test("a paused workspace is never a candidate or ready to close, whatever it last said (SW-70)", async () => {
  // `focus`: the test above left one, so the sweep keeps focus workspaces only.
  workspace("f-paused", { labels: ["focus"], gate: "proposed" });
  workspace("g-live", { labels: ["focus"], gate: "proposed" });
  const dot = path.join(root, "f-paused", ".werkmeister");
  writeSessionState(path.join(root, "f-paused"), "needs-you", { question: "Which fix?" });
  fs.writeFileSync(
    path.join(dot, "paused.json"),
    JSON.stringify({ at: new Date().toISOString(), containers: [], was_working: false }),
  );
  const r = await checkInTriage();
  const row = (n) => r.workspaces.find((w) => w.name === n);
  assert.equal(row("f-paused").paused, true);
  assert.equal(row("g-live").paused, false);
  assert.ok(!r.candidates.includes("f-paused"));
  assert.ok(r.candidates.includes("g-live"));
  assert.ok(!r.readyToClose.includes("f-paused"));
});

test("a PR file at status: draft is a gate; once approved it is not (SW-478)", async () => {
  // `focus`: earlier tests left some, so the sweep keeps focus workspaces only.
  workspace("h-pr", { labels: ["focus"] });
  const out = path.join(root, "h-pr", "stages", "02_plan", "output");
  fs.writeFileSync(path.join(out, "pr-werkmeister.md"), "---\nstatus: draft\n---\n");
  const gates = async () => (await checkInTriage()).workspaces.find((w) => w.name === "h-pr").gates;
  assert.deepEqual(await gates(), [path.join("stages", "02_plan", "output", "pr-werkmeister.md")]);
  fs.writeFileSync(
    path.join(out, "pr-werkmeister.md"),
    "---\nstatus: approved  # approved via check-in 2026-11-06\n---\n",
  );
  assert.deepEqual(await gates(), []);
});
