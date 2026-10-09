// How Claude prompts address the Jira site for the Atlassian MCP tools:
// jira.cloud_id, else the jira.base_url hostname, else an instruction to look it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cfg = path.join(mkdtempSync(path.join(tmpdir(), "jira-site-")), "config.yaml");
process.env.SANDBOX_CONFIG_FILE = cfg;
const { jiraSiteRef, jiraSitePhrase } = await import("./dist/issue_tracker.js");

test("cloud_id wins over base_url", () => {
  writeFileSync(cfg, "jira:\n  cloud_id: abc-123\n  base_url: https://acme.atlassian.net/\n");
  assert.equal(jiraSiteRef(), "abc-123");
});

test("base_url hostname when no cloud_id", () => {
  writeFileSync(cfg, "jira:\n  base_url: https://acme.atlassian.net/jira/\n");
  assert.equal(jiraSiteRef(), "acme.atlassian.net");
  assert.equal(jiraSitePhrase(), "(Atlassian cloud id acme.atlassian.net)");
});

test("scheme-less base_url still resolves", () => {
  writeFileSync(cfg, "jira:\n  base_url: acme.atlassian.net\n");
  assert.equal(jiraSiteRef(), "acme.atlassian.net");
});

test("nothing configured → null and a lookup instruction", () => {
  writeFileSync(cfg, "paths: {}\n");
  assert.equal(jiraSiteRef(), null);
  assert.match(jiraSitePhrase(), /getAccessibleAtlassianResources/);
});

test("scheme-less base_url still gives an absolute browse link", async () => {
  const { jiraBrowseUrl } = await import("./dist/issue_tracker.js");
  writeFileSync(cfg, "jira:\n  base_url: acme.atlassian.net/\n");
  assert.equal(jiraBrowseUrl("PROJ-1"), "https://acme.atlassian.net/browse/PROJ-1");
});
