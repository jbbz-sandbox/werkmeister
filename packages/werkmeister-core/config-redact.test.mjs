// SW-268: the machine-config view masks secrets by key name at any depth.

import assert from "node:assert/strict";
import { test } from "node:test";
import { redact, redactedYaml } from "./dist/global_config.js";

const TOKEN = "dummy-tok-123";
const cfg = () => ({
  jira: { base_url: "https://x.atlassian.net", email: "a@b.c", api_token: TOKEN },
  overrides: { deploy_password: "hunter2", services_yaml: "/tmp/s.yaml" },
  projects: { x: { client_secret: "s3", key: "SW" }, list: [{ auth_header: "Bearer z" }] },
});

test("jira.api_token and other secret-named keys are masked, the rest stays visible", () => {
  const r = redact(cfg());
  assert.equal(r.jira.api_token, "<redacted>");
  assert.equal(r.jira.base_url, "https://x.atlassian.net");
  assert.equal(r.overrides.deploy_password, "<redacted>");
  assert.equal(r.overrides.services_yaml, "/tmp/s.yaml");
  assert.equal(r.projects.x.client_secret, "<redacted>");
  assert.equal(r.projects.x.key, "SW");
  assert.equal(r.projects.list[0].auth_header, "<redacted>");
});

test("an unset secret stays empty and the input is not mutated", () => {
  const input = cfg();
  input.jira.api_token = "";
  const r = redact(input);
  assert.equal(r.jira.api_token, "");
  assert.equal(input.overrides.deploy_password, "hunter2");
});

test("redactedYaml never contains a secret value", () => {
  const out = redactedYaml(cfg());
  for (const v of [TOKEN, "hunter2", "s3", "Bearer z"]) assert.ok(!out.includes(v), v);
  assert.ok(out.includes("base_url"));
});
