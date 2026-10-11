import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withFakeGh, withSandboxHome } from "./fixtures.mjs";
import {
  IssueFetchError, fetchIssueSnapshot, parseIssueCopy, readIssueRef, renderIssueCopy, writeIssueCopy,
} from "./dist/issue_snapshot.js";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = {
  title: "Stale config survives up",
  state: "OPEN",
  body: "Ran it.\n\n---\n\n## Expected\nGone.",
  url: "https://github.com/o/r/issues/5",
  labels: [{ name: "bug" }],
  assignees: [],
  comments: [{ author: { login: "amy" }, createdAt: "2026-10-02T10:00:00Z", body: "Still there." }],
};
const NOW = () => new Date("2026-10-11T18:04:00Z");

test("fetchIssueSnapshot keeps the body and every comment", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const s = await fetchIssueSnapshot("o/r#5", NOW);
      assert.deepEqual(s, {
        ref: "o/r#5", url: "https://github.com/o/r/issues/5", tracker: "github",
        title: "Stale config survives up", status: "Open", body: ISSUE.body,
        comments: [{ author: "amy", created: "2026-10-02T10:00:00Z", body: "Still there." }],
        fetchedAt: "2026-10-11T18:04:00.000Z",
      });
    });
  }, { config: GH });
});

test("fetchIssueSnapshot throws IssueFetchError when the tracker can't read it", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: null }, async () => {
      await assert.rejects(fetchIssueSnapshot("o/r#5", NOW), IssueFetchError);
    });
  }, { config: GH });
});

test("body with --- and headings round-trips", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({ issue: ISSUE }, async () => {
      const s = await fetchIssueSnapshot("o/r#5", NOW);
      const text = renderIssueCopy(s);
      assert.match(text, /^---\nref: o\/r#5\nurl: https:\/\/github.com\/o\/r\/issues\/5\ntracker: github\nstatus: Open\nfetched: 2026-10-11T18:04:00.000Z\n---\n\n# Stale config survives up\n/);
      assert.match(text, /\n## Comments\n\n### amy · 2026-10-02T10:00:00Z\n\nStill there.\n$/);
      assert.deepEqual(parseIssueCopy(text), s);
    });
  }, { config: GH });
});

test("readIssueRef: copy, else a no-copy ref from issue_id, else null", async () => {
  await withSandboxHome(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    assert.equal(readIssueRef(root, ""), null);
    assert.deepEqual(readIssueRef(root, "o/r#5"), {
      ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "", fetchedAt: null,
    });
    await withFakeGh({ issue: ISSUE }, async () => writeIssueCopy(root, await fetchIssueSnapshot("o/r#5", NOW)));
    assert.deepEqual(readIssueRef(root, "o/r#5"), {
      ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "Stale config survives up",
      fetchedAt: "2026-10-11T18:04:00.000Z",
    });
  }, { config: GH });
});
