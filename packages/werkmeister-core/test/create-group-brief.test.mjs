// SW-1060: a grouped create's starting prompt (and so BRIEF.md) gets an acceptance subsection per member,
// from that member's ticket, and never names a member as a non-goal. Against the fake Jira.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const { startFakeJira } = await import("../dist/fixture_fakes.js");
const jira = await startFakeJira();
after(() => jira.close());
process.env.JIRA_BASE_URL = jira.url;
process.env.JIRA_EMAIL = "fixture@example.invalid";
process.env.JIRA_API_TOKEN = "fixture";
const { collectingReporter, withReporter } = await import("../dist/reporter.js");
const { prepareCreate } = await import("../dist/sandbox.js");
const { withSandboxHome } = await import("./fixtures.mjs");

// The model put the grouping comment under non-goals, as SW-1060 saw.
const ANSWER = JSON.stringify({
  starting_prompt:
    "## Goal\n\nFix SW-595.\n\n## Where to start\n\n- Non-goals: the other grouped tickets' work (SW-597, SW-585).\n- The docs page.\n\n## Acceptance criteria\n\n- [ ] SW-595 done.",
});

test("a grouped create writes a criteria subsection per member, lead first, no member non-goal", async () => {
  const prompts = [];
  const { resolved } = await withSandboxHome(
    () =>
      withReporter(collectingReporter(), () =>
        prepareCreate(
          { feature: "docs", issue_id: "SW-595", group: "SW-597,SW-585" },
          {
            cwd: fs.mkdtempSync(path.join(os.tmpdir(), "cwd-")),
            distill: async (p) => {
              prompts.push(p);
              return `<result>${ANSWER}</result>`;
            },
          },
        ),
      ),
    { config: "overrides:\n  issue_tracker: jira\n" },
  );
  // The extractor reads each member and is told the group rules.
  assert.match(prompts[0], /Grouped ticket SW-597/);
  assert.match(prompts[0], /never list a grouped ticket as a non-goal/i);
  assert.match(prompts[0], /one grouped PR for SW-595, SW-597, SW-585 \(one commit per ticket\)/);
  const p = resolved.starting_prompt;
  assert.match(p, /### SW-597 [^\n]*\n(?:[^\n]*\n)*?- \[ \] Member criterion one\./);
  assert.match(p, /### SW-585 Werkmeister docs overhaul\n- \[ \] /);
  assert.ok(p.indexOf("### SW-597") < p.indexOf("### SW-585"), "members in group order");
  for (const line of p.split("\n").filter((l) => /non-goal/i.test(l)))
    assert.doesNotMatch(line, /SW-597|SW-585/, line);
  assert.match(p, /- The docs page\./, "the rest of the prompt is kept");
});

test("with no distill, the starting prompt still carries each member's criteria", async () => {
  const { resolved } = await withSandboxHome(
    () =>
      withReporter(collectingReporter(), () =>
        prepareCreate(
          { feature: "docs", issue_id: "SW-595", group: "SW-597" },
          { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "cwd-")), distill: false },
        ),
      ),
    { config: "overrides:\n  issue_tracker: jira\n" },
  );
  assert.match(resolved.starting_prompt, /^## Acceptance criteria: grouped tickets\n/);
  assert.match(resolved.starting_prompt, /### SW-597 [^\n]*\n- \[ \] Member criterion one\./);
});
