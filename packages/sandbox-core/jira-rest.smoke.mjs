// Smoke test for jira-rest: creds resolution (config YAML + env override) and
// briefing formatting; plus a LIVE section (issue fetch + batch status) that runs
// only when real credentials are configured in ~/.sandbox/config.yaml.
//   npm run build && node jira-rest.smoke.mjs [LIVE-KEY]
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const { jiraCreds, briefingFromIssue, fetchIssueRest, fetchStatusesRest } =
  await import(path.join(pkgRoot, "dist", "jira-rest.js"));

// 1. creds from the `jira:` section, trailing slash stripped from base_url
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jira-smoke-"));
const cfgFile = path.join(tmp, "config.yaml");
fs.writeFileSync(
  cfgFile,
  "paths: {}\njira:\n  base_url: https://y.atlassian.net/\n  email: c@d.e\n  api_token: yaml-tok\n",
);
process.env.SANDBOX_CONFIG_FILE = cfgFile;
assert.deepEqual(await jiraCreds(), {
  baseUrl: "https://y.atlassian.net",
  email: "c@d.e",
  token: "yaml-tok",
});

// 2. briefingFromIssue: full card
const briefing = briefingFromIssue({
  key: "PROJ-1",
  fields: {
    summary: "Do the thing",
    description: "  Long body  ",
    status: { name: "In Progress" },
    issuetype: { name: "Story" },
    assignee: { displayName: "Jay" },
    comment: {
      comments: [
        { author: { displayName: "A" }, body: "first", created: "2026-07-01T00:00:00Z" },
        { author: { displayName: "B" }, body: "  ", created: "2026-07-02T00:00:00Z" }, // blank → dropped
        { body: "no author" },
      ],
    },
  },
});
assert.match(briefing, /^PROJ-1: Do the thing/);
assert.match(briefing, /Status: In Progress · Type: Story · Assignee: Jay/);
assert.match(briefing, /Description:\nLong body/);
assert.match(briefing, /- \[A 2026-07-01\] first/);
assert.match(briefing, /- \[unknown\] no author/);
assert.ok(!briefing.includes("[B"));

// 3. briefingFromIssue: sparse card (no description/comments/meta)
const sparse = briefingFromIssue({ key: "PROJ-2", fields: {} });
assert.equal(sparse, "PROJ-2: (no summary)");

// 4. process env overrides the YAML, but a placeholder token never counts as a
// credential — it falls through to the configured section instead.
process.env.JIRA_BASE_URL = "https://x.atlassian.net";
process.env.JIRA_EMAIL = "a@b.c";
process.env.JIRA_API_TOKEN = "PASTE_TOKEN_HERE";
assert.equal(
  (await jiraCreds()).token,
  "yaml-tok",
  "placeholder token in env must never be used as a credential",
);
process.env.JIRA_API_TOKEN = "real";
assert.equal((await jiraCreds()).baseUrl, "https://x.atlassian.net");
delete process.env.JIRA_BASE_URL;
delete process.env.JIRA_EMAIL;
delete process.env.JIRA_API_TOKEN;

// 5. no readable config → no creds (callers degrade to the claude CLI path)
process.env.SANDBOX_CONFIG_FILE = path.join(tmp, "absent.yaml");
assert.equal(await jiraCreds(), null);
delete process.env.SANDBOX_CONFIG_FILE;
fs.rmSync(tmp, { recursive: true, force: true });

console.log("jira-rest pure-function smoke: PASS");

// 6. LIVE (needs real creds in ~/.sandbox/config.yaml and a real issue key in argv —
// no default key, since a hardcoded one only exists on one Jira site)
const creds = await jiraCreds();
if (!creds || !process.argv[2]) {
  console.log(`live section: SKIPPED (${creds ? "pass an issue key as argv[2]" : "no credentials"})`);
} else {
  const key = process.argv[2];
  const issue = await fetchIssueRest(key);
  assert.ok(issue, `fetchIssueRest(${key}) returned null with creds present`);
  assert.equal(issue.key.toUpperCase(), key.toUpperCase());
  assert.ok(issue.fields.summary, "live issue has a summary");
  const statuses = await fetchStatusesRest([key]);
  assert.ok(statuses?.[key.toUpperCase()], "batch status returned the key");
  console.log(`live smoke: PASS (${key}: ${statuses[key.toUpperCase()]} — "${issue.fields.summary}")`);
}
