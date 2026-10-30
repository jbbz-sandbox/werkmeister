import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { seedWorkspaceMetadataEnv } from "./dist/generate.js";
import { issueCopyPath } from "./dist/issue_snapshot.js";
import { resolveIssueCopy } from "./dist/workspace_init.js";
import { resolveInputs } from "./dist/workspace_prompts.js";
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

// SW-207: an unquoted DESCRIPTION starting with a quote made compose reject the file.
test("DESCRIPTION with quotes, $, # and \\ is quoted for compose and round-trips", () => {
  const root = tmp();
  const env = path.join(root, ".env");
  const desc = `'werkmeister pr status' stays at 'merged' — "q" costs $5 #tag back\\slash`;
  seedWorkspaceMetadataEnv(env, { FEATURE: "f", DESCRIPTION: desc });
  const written = fs.readFileSync(env, "utf8");
  assert.equal(
    written,
    `FEATURE=f\nDESCRIPTION="'werkmeister pr status' stays at 'merged' — \\"q\\" costs \\$5 #tag back\\\\slash"\n`,
  );
  // A bare re-run reads the value back from .env and re-seeds it: no double quoting.
  process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";
  assert.equal(resolveInputs({}, root).description, desc);
  seedWorkspaceMetadataEnv(env, { FEATURE: "f", DESCRIPTION: resolveInputs({}, root).description });
  assert.equal(fs.readFileSync(env, "utf8"), written);
});
