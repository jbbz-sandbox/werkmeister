// SW-945: jira.api_token is a live credential. It lives in secrets.env (JIRA_API_TOKEN), never in
// config.yaml, so a raw read of config.yaml to check a setting shows none. Same rule as SW-759.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { loadJira, save } from "../dist/global_config.js";
import { jiraCreds } from "../dist/jira-rest.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-token-"));
const file = path.join(dir, "config.yaml");
const secrets = path.join(dir, "secrets.env");
process.env.WERKMEISTER_CONFIG_FILE = file;
for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];

const BLOCK =
  "jira:\n  base_url: https://x.atlassian.net\n  email: a@b.c\n  api_token: legacy-tok\n";

test("save moves jira.api_token out of config.yaml into secrets.env (0600)", (t) => {
  t.after(() => fs.rmSync(secrets, { force: true }));
  fs.writeFileSync(secrets, "OTHER=keep\n");
  save(parse(BLOCK));
  const yaml = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(yaml, /legacy-tok|api_token/);
  assert.match(yaml, /base_url: https:\/\/x\.atlassian\.net/);
  assert.equal(fs.readFileSync(secrets, "utf8"), "OTHER=keep\nJIRA_API_TOKEN=legacy-tok\n");
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
});

test("readers take the token from secrets.env first, config.yaml as the fallback", async (t) => {
  t.after(() => fs.rmSync(secrets, { force: true }));
  // Fallback: an un-migrated config.yaml still works.
  fs.writeFileSync(file, BLOCK);
  assert.equal(loadJira().api_token, "legacy-tok");
  assert.equal((await jiraCreds())?.token, "legacy-tok");
  // secrets.env wins over a stale config.yaml value.
  fs.writeFileSync(secrets, "JIRA_API_TOKEN=rotated-tok\n");
  assert.equal(loadJira().api_token, "rotated-tok");
  assert.equal((await jiraCreds())?.token, "rotated-tok");
  // Moved: no token in config.yaml at all.
  fs.writeFileSync(file, "jira:\n  base_url: https://x.atlassian.net\n  email: a@b.c\n");
  assert.equal(loadJira().api_token, "rotated-tok");
  assert.equal((await jiraCreds())?.token, "rotated-tok");
});

test("save keeps a token already in secrets.env over a stale config.yaml one", (t) => {
  t.after(() => fs.rmSync(secrets, { force: true }));
  fs.writeFileSync(secrets, "JIRA_API_TOKEN=renewed-tok\n");
  save(parse(BLOCK)); // `machine config --write` round-trips the raw block
  assert.equal(fs.readFileSync(secrets, "utf8"), "JIRA_API_TOKEN=renewed-tok\n");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /tok/);
});

test("a token typed into machine setup replaces the one in secrets.env, other lines kept", async (t) => {
  t.after(() => fs.rmSync(secrets, { force: true }));
  const { writeSecret } = await import("../dist/global_config.js");
  fs.writeFileSync(secrets, "OTHER=keep\nJIRA_API_TOKEN=old-tok\n");
  writeSecret("JIRA_API_TOKEN", "new-tok");
  assert.equal(fs.readFileSync(secrets, "utf8"), "OTHER=keep\nJIRA_API_TOKEN=new-tok\n");
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
});

test("a token pasted on a second line wins, as loadSecrets reads it; writeSecret leaves one line", async (t) => {
  t.after(() => fs.rmSync(secrets, { force: true }));
  const { writeSecret } = await import("../dist/global_config.js");
  fs.writeFileSync(file, "jira:\n  base_url: https://x.atlassian.net\n  email: a@b.c\n");
  fs.writeFileSync(secrets, "JIRA_API_TOKEN=old-tok\nOTHER=keep\nJIRA_API_TOKEN=pasted-tok\n");
  assert.equal(loadJira().api_token, "pasted-tok");
  writeSecret("JIRA_API_TOKEN", "new-tok");
  assert.equal(fs.readFileSync(secrets, "utf8"), "OTHER=keep\nJIRA_API_TOKEN=new-tok\n");
});
