import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueRef } from "./dist/strategies/issue_section.js";

test("renderIssueRef with a stored copy", () => {
  assert.equal(
    renderIssueRef({
      ref: "o/r#5",
      url: "https://github.com/o/r/issues/5",
      title: "Stale config",
      fetchedAt: "2026-10-11T18:04:00.000Z",
    }),
    "## Issue\n\n[o/r#5](https://github.com/o/r/issues/5): Stale config. Copy taken 2026-10-11: `.werkmeister/issue.md`.\n" +
      "Before each stage, re-read the live issue for newer direction: `werkmeister issue view`\n" +
      "Its status moves by itself (In Progress → In Review → Done): `docs/workspace-lifecycle.md` § Issue status in the werkmeister repo.\n",
  );
});

test("renderIssueRef without a copy or url (Jira, no base_url)", () => {
  assert.equal(
    renderIssueRef({ ref: "PROJ-12", url: null, title: "", fetchedAt: null }),
    "## Issue\n\nPROJ-12. No stored copy; run `werkmeister workspace init --refresh-issue`.\n" +
      "Before each stage, re-read the live issue for newer direction: `werkmeister issue view`\n" +
      "Its status moves by itself (In Progress → In Review → Done): `docs/workspace-lifecycle.md` § Issue status in the werkmeister repo.\n",
  );
});
