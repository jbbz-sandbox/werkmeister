// checkInTriage's PR and release state (SW-65): lifecycle and prs per row, merged PRs
// shipped by a release tag before reporting, and readyToClose. git and the tracker are
// stubbed at the `deps` seam; PR files, lifecycle and the sweep's rules are real.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "check-in-release-"));
const root = path.join(home, "features");
process.env.HOME = home;
// The callback lock lives next to the config file.
process.env.WERKMEISTER_CONFIG_FILE = path.join(home, ".werkmeister", "config.yaml");
process.env.WERKMEISTER_WORKSPACES_ROOT = root;

const { checkInTriage } = await import("./dist/sandbox.js");
const { resolveIssueStatuses } = await import("./dist/issue_status.js");
const lockFile = path.join(home, ".werkmeister", "pr-callbacks.lock");

/** A workspace with one PR file (`fm` frontmatter lines), or none when `fm` is null. */
function workspace(name, fm, { labels = [], closedOut = false, agent, lastRole } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".werkmeister", "workspace.yml"),
    `labels: [${labels.join(", ")}]\nissue_id: o/app#${name.length}\n`,
  );
  const out = path.join(dir, "stages", "04_propose", "output");
  fs.mkdirSync(out, { recursive: true });
  if (fm) fs.writeFileSync(path.join(out, "pr-app.md"), `---\n${fm}\n---\n# feat: x\n`);
  if (closedOut) fs.writeFileSync(path.join(dir, "closeout.md"), "closed\n");
  if (agent)
    fs.writeFileSync(
      path.join(dir, ".werkmeister", "agent-state.json"),
      JSON.stringify({ state: agent, at: new Date().toISOString() }),
    );
  if (lastRole) {
    const project = path.join(home, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    const line = { type: lastRole, message: { role: lastRole, content: "hi" } };
    fs.writeFileSync(path.join(project, "s1.jsonl"), `${JSON.stringify(line)}\n`);
  }
  return dir;
}

const prFm = (status, extra = "") =>
  `repo: o/app\nbranch: me/ws\nbase: main\nstatus: ${status}\nurl: https://x/pr/1\n${extra}`;

function deps(table) {
  const calls = [];
  const updates = [];
  return {
    calls,
    updates,
    run: async (bin, args) => {
      const line = [bin, ...args].join(" ");
      calls.push(line);
      for (const [re, stdout] of table) if (re.test(line)) return { stdout, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    repos: { app: { ship: "tag", release_tag: "v*" } },
    tracker: {
      fetchIssue: async (ref) => ({ ref, status: "OPEN" }),
      updateIssue: async (ref, u) => {
        updates.push([ref, u]);
      },
    },
    statuses: resolveIssueStatuses({}, "github"),
    commitRecord: async () => ({ ok: true, message: "record pushed" }),
    stop: async () => "containers stopped",
  };
}

const prOf = (ws) =>
  fs.readFileSync(path.join(ws, "stages", "04_propose", "output", "pr-app.md"), "utf8");

test("lifecycle, prs and readyToClose; a new tag ships a merged PR during the sweep", async () => {
  workspace("a-working", null);
  workspace("b-ready", prFm("approved"));
  workspace("c-pr-open", prFm("open"));
  const waits = workspace("d-merged", prFm("merged", "merge_sha: def"));
  workspace("e-shipped", prFm("shipped", "release: v1.0.0"), { lastRole: "assistant" });
  workspace("f-abandoned", prFm("abandoned", "reason: dropped"));
  workspace("g-closed-out", prFm("shipped", "release: v1.0.0"), { closedOut: true });
  const ships = workspace("h-ships-now", prFm("merged", "merge_sha: abc"));
  workspace("i-busy", prFm("shipped", "release: v1.0.0"), { agent: "working" });
  workspace("j-parked", prFm("shipped", "release: v1.0.0"), { labels: ["skip"] });

  const d = deps([[/tag --contains abc --list v\*/, "v1.2.0\n"]]);
  const r = await checkInTriage(d);

  assert.deepEqual(
    r.workspaces.map((w) => [w.name, w.lifecycle]),
    [
      ["a-working", "working"],
      ["b-ready", "ready"],
      ["c-pr-open", "pr-open"],
      ["d-merged", "merged"],
      ["e-shipped", "shipped"],
      ["f-abandoned", "abandoned"],
      ["g-closed-out", "closed-out"],
      ["h-ships-now", "shipped"],
      ["i-busy", "shipped"],
    ],
  );
  const row = (n) => r.workspaces.find((w) => w.name === n);
  assert.deepEqual(row("a-working").prs, []);
  assert.deepEqual(row("h-ships-now").prs, [
    { repo: "app", url: "https://x/pr/1", status: "shipped", release: "v1.2.0" },
  ]);
  // A merged version-bump PR whose release job published no tag (0.20.0) is not shipped.
  assert.deepEqual(row("d-merged").prs[0], {
    repo: "app",
    url: "https://x/pr/1",
    status: "merged",
    release: null,
  });
  assert.match(prOf(ships), /status: shipped/);
  assert.match(prOf(ships), /release: v1\.2\.0/);
  assert.match(prOf(waits), /status: merged/);

  assert.deepEqual(r.readyToClose, ["e-shipped", "f-abandoned", "h-ships-now"]);
  assert.deepEqual(r.dropped, ["j-parked"]);
  // e-shipped is a first-run candidate (Claude spoke last) but goes to readyToClose only.
  assert.deepEqual(r.candidates, []);

  // Tags fetched only where a merged PR could ship; no gh call, not even for the open PR.
  assert.ok(d.calls.every((c) => !c.startsWith("gh ")));
  assert.deepEqual(
    d.calls.filter((c) => c.includes("fetch")).map((c) => c.split(" ")[2]),
    [path.join(waits, "app"), path.join(ships, "app")],
  );
  // The issue moves as `pr status` moves it.
  assert.equal(d.updates.length, 1);
  assert.match(d.updates[0][1].comment, /^Shipped: v1\.2\.0 — https:\/\/x\/pr\/1/);
});

test("the sweep skips shipping while a callback pass holds the lock", async () => {
  const ws = workspace("k-locked", prFm("merged", "merge_sha: abc"));
  fs.writeFileSync(lockFile, "");
  try {
    const d = deps([[/tag --contains abc/, "v1.2.0\n"]]);
    const r = await checkInTriage(d);
    assert.deepEqual(d.calls, []);
    assert.match(prOf(ws), /status: merged/);
    assert.equal(r.workspaces.find((w) => w.name === "k-locked").lifecycle, "merged");
    assert.ok(!r.readyToClose.includes("k-locked"));
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
});
