import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { seedWorkspaceMetadataEnv } from "./dist/generate.js";
import { issueCopyPath } from "./dist/issue_snapshot.js";
import { resolveIssueCopy } from "./dist/workspace_init.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

const GH = "overrides:\n  issue_tracker: github\n";
const ISSUE = {
  title: "T",
  state: "OPEN",
  body: "b",
  url: "https://github.com/o/r/issues/5",
  labels: [],
  assignees: [],
  comments: [],
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));

test("missing copy renders the no-copy section", async () => {
  await withSandboxHome(
    async () => {
      const ref = await resolveIssueCopy(tmp(), "o/r#5", {});
      assert.equal(ref.fetchedAt, null);
    },
    { config: GH },
  );
});

test("refresh writes the copy; a failed refresh keeps the old one", async () => {
  await withSandboxHome(
    async () => {
      const root = tmp();
      await withFakeGh({ issue: ISSUE }, () => resolveIssueCopy(root, "o/r#5", { refresh: true }));
      const before = fs.readFileSync(issueCopyPath(root), "utf8");
      await withFakeGh({ issue: null }, async () => {
        await assert.rejects(
          resolveIssueCopy(root, "o/r#5", { refresh: true }),
          /couldn't read o\/r#5/,
        );
      });
      assert.equal(fs.readFileSync(issueCopyPath(root), "utf8"), before);
    },
    { config: GH },
  );
});

test("refresh without issue_id fails cleanly", async () => {
  const root = tmp();
  await assert.rejects(resolveIssueCopy(root, "", { refresh: true }), /no issue_id/);
  assert.equal(fs.existsSync(issueCopyPath(root)), false);
});

test("multi-line DESCRIPTION is one .env line", () => {
  const env = path.join(tmp(), ".env");
  seedWorkspaceMetadataEnv(env, { FEATURE: "f", DESCRIPTION: "line one\n\n  line two" });
  assert.equal(fs.readFileSync(env, "utf8"), "FEATURE=f\nDESCRIPTION=line one line two\n");
});
