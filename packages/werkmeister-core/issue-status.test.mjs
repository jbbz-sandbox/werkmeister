// The issue status follows the lifecycle (SW-27): config resolution, the forward-only
// position check and warn-and-continue. The tracker is a stub; nothing reaches Jira or GitHub.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/config.js";
import { issuePosition, moveIssue, resolveIssueStatuses, startIssue } from "./dist/issue_status.js";

const JIRA = resolveIssueStatuses({}, "jira");
const GITHUB = resolveIssueStatuses({}, "github");

/** A tracker stub holding one issue; records every update. */
function tracker(issue, { refuse } = {}) {
  const updates = [];
  return {
    updates,
    fetchIssue: async () => issue,
    updateIssue: async (ref, u) => {
      if (refuse) throw new Error(refuse);
      updates.push([ref, u]);
    },
  };
}

test("defaults fit Jira's standard workflow and GitHub status: labels", () => {
  assert.deepEqual(JIRA, {
    in_progress: "In Progress",
    in_review: "In Review",
    merged: null,
    done: "Done",
    abandoned: null,
  });
  assert.deepEqual(GITHUB, {
    in_progress: "status: in progress",
    in_review: "status: in review",
    merged: null,
    done: "closed",
    abandoned: "not planned",
  });
});

test("issue_statuses beats the aliases, the aliases beat the defaults, null or blank skips", () => {
  const s = resolveIssueStatuses(
    {
      issue_review_status: "Peer Review",
      issue_done_status: "Released",
      issue_statuses: { done: "Closed", in_progress: null, merged: "", abandoned: "Won't Do" },
    },
    "jira",
  );
  assert.equal(s.in_review, "Peer Review", "alias, the map doesn't name it");
  assert.equal(s.done, "Closed", "the map wins over issue_done_status");
  assert.equal(s.in_progress, null);
  assert.equal(s.merged, null);
  assert.equal(s.abandoned, "Won't Do");
  assert.equal(resolveIssueStatuses({ issue_done_status: "Released" }, "github").done, "Released");
});

test("issue_progress_status sets in_progress (SW-24) unless issue_statuses names it", () => {
  assert.equal(
    resolveIssueStatuses({ issue_progress_status: "Doing" }, "jira").in_progress,
    "Doing",
  );
  assert.equal(
    resolveIssueStatuses({ issue_progress_status: "wip" }, "github").in_progress,
    "wip",
    "on GitHub, a label",
  );
  assert.equal(
    resolveIssueStatuses(
      { issue_progress_status: "Doing", issue_statuses: { in_progress: "Started" } },
      "jira",
    ).in_progress,
    "Started",
  );
});

test("issuePosition: Jira category and name, GitHub state and status: label", () => {
  const p = (issue, s = JIRA) => issuePosition({ ref: "X-1", ...issue }, s);
  assert.equal(p({ status: "To Do", statusCategory: "new" }), 0);
  assert.equal(p({ status: "In Progress", statusCategory: "indeterminate" }), 1);
  assert.equal(p({ status: "In Review", statusCategory: "indeterminate" }), 2);
  assert.equal(p({ status: "Blocked", statusCategory: "indeterminate" }), 1);
  assert.equal(p({ status: "Shipped", statusCategory: "done" }), 4);
  assert.equal(p({ status: "done" }), 4, "no category: the name decides");
  assert.equal(p({ status: "Open", labels: [] }, GITHUB), 0);
  assert.equal(p({ status: "Open", labels: ["bug", "status: in review"] }, GITHUB), 2);
  assert.equal(p({ status: "Closed", statusCategory: "done", labels: [] }, GITHUB), 4);
});

test("moveIssue moves forward and comments with the trigger", async () => {
  const t = tracker({ ref: "X-1", status: "To Do", statusCategory: "new" });
  const line = await moveIssue(t, "X-1", "in_progress", JIRA, { comment: "Work started." });
  assert.equal(line, "X-1 → In Progress");
  assert.deepEqual(t.updates, [["X-1", { status: "In Progress", comment: "Work started." }]]);
});

test("moveIssue never drags an issue back from In Review or Done on a re-run", async () => {
  for (const issue of [
    { ref: "X-1", status: "In Review", statusCategory: "indeterminate" },
    { ref: "X-1", status: "Done", statusCategory: "done" },
  ]) {
    const t = tracker(issue);
    assert.equal(
      await moveIssue(t, "X-1", "in_progress", JIRA, { comment: "c" }),
      `X-1 already ${issue.status}`,
    );
    assert.equal(
      await moveIssue(t, "X-1", "in_review", JIRA, { comment: "c" }).then(() => t.updates.length),
      0,
      "in_review is not ahead of In Review or Done",
    );
  }
});

test("moveIssue back: from In Review to In Progress, never from Done", async () => {
  const review = tracker({ ref: "X-1", status: "In Review", statusCategory: "indeterminate" });
  assert.equal(
    await moveIssue(review, "X-1", "in_progress", JIRA, { comment: "c", back: true }),
    "X-1 → In Progress",
  );
  const done = tracker({ ref: "X-1", status: "Done", statusCategory: "done" });
  await moveIssue(done, "X-1", "in_progress", JIRA, { comment: "c", back: true });
  assert.deepEqual(done.updates, []);
});

test("moveIssue: a refusal is a warning naming the status and the available transitions", async () => {
  const t = tracker(
    { ref: "X-1", status: "To Do", statusCategory: "new" },
    { refuse: 'X-1 has no transition to "In Review" (available: In Progress, Done)' },
  );
  const line = await moveIssue(t, "X-1", "in_review", JIRA, { comment: "c" });
  assert.equal(
    line,
    'X-1 not moved to "In Review": X-1 has no transition to "In Review" (available: In Progress, Done)',
  );
  const noCreds = {
    fetchIssue: async () => {
      throw new Error("no credentials");
    },
    updateIssue: async () => {},
  };
  assert.match(
    await moveIssue(noCreds, "X-1", "done", JIRA, { comment: "c" }),
    /not moved to "Done": no credentials/,
  );
});

test("moveIssue: an unreadable issue is not moved; a null status does nothing unless alwaysComment", async () => {
  const unread = tracker(null);
  assert.match(
    await moveIssue(unread, "X-1", "in_review", JIRA, { comment: "c" }),
    /could not read its current status/,
  );
  assert.deepEqual(unread.updates, []);
  const t = tracker({ ref: "X-1", status: "In Review", statusCategory: "indeterminate" });
  assert.equal(await moveIssue(t, "X-1", "merged", JIRA, { comment: "c" }), "");
  await moveIssue(t, "X-1", "abandoned", JIRA, { comment: "Abandoned: why", alwaysComment: true });
  assert.deepEqual(t.updates, [["X-1", { comment: "Abandoned: why" }]]);
});

test("moveIssue: a failed read is retried once; a second failure says why and how to move it by hand (SW-109)", async () => {
  let reads = 0;
  const flaky = {
    updates: [],
    fetchIssue: async (_ref, why) => {
      if (++reads === 1) {
        why?.push("Jira REST: fetch failed (ECONNRESET)");
        return null;
      }
      return { ref: "X-1", status: "In Progress", statusCategory: "indeterminate" };
    },
    updateIssue: async (ref, u) => flaky.updates.push([ref, u]),
  };
  assert.equal(
    await moveIssue(flaky, "X-1", "in_review", JIRA, { comment: "PR opened: u" }),
    "X-1 → In Review",
  );
  assert.equal(reads, 2);

  const down = {
    fetchIssue: async (_ref, why) => {
      why?.push("Jira REST /rest/api/2/issue/X-1 → HTTP 503");
      why?.push("the Atlassian MCP fallback returned no issue");
      return null;
    },
    updateIssue: async () => assert.fail("an unread issue is never moved"),
  };
  assert.equal(
    await moveIssue(down, "X-1", "in_review", JIRA, { comment: "PR opened: u" }),
    'X-1 not moved to "In Review": could not read its current status ' +
      "(Jira REST /rest/api/2/issue/X-1 → HTTP 503; the Atlassian MCP fallback returned no issue); " +
      'move it by hand: werkmeister issue update X-1 --status "In Review" --comment "PR opened: u"',
  );
});

test("startIssue: names the first stage without output; no issue, no move", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "issue-start-"));
  try {
    for (const d of ["01_research", "02_spec"])
      fs.mkdirSync(path.join(ws, "stages", d, "output"), { recursive: true });
    fs.writeFileSync(path.join(ws, "stages", "01_research", "output", ".gitkeep"), "");
    fs.mkdirSync(dotDir(ws), { recursive: true });
    fs.writeFileSync(path.join(dotDir(ws), "workspace.yml"), "feature: f\nissue_id: X-1\n");
    const t = tracker({ ref: "X-1", status: "To Do", statusCategory: "new" });
    assert.equal(await startIssue(ws, t, JIRA), "X-1 → In Progress");
    assert.deepEqual(t.updates, [
      [
        "X-1",
        {
          status: "In Progress",
          comment: `Work started: stage 01_research in workspace ${path.basename(ws)}.`,
        },
      ],
    ]);
    fs.writeFileSync(path.join(dotDir(ws), "workspace.yml"), "feature: f\n");
    assert.equal(await startIssue(ws, t, JIRA), "no issue");
    assert.equal(t.updates.length, 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
