// The workspaces pane runs the issue-distillation prompt on its own session
// model and hands the raw answer back here, so this parse is the only thing
// between model output and the form: pinned here.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let applyIssueFormAnswer;
before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "issue-form-"));
  const yaml = path.join(dir, "services.yaml");
  await writeFile(yaml, "services:\n  api:\n    repo: api\n  web:\n    repo: web\ninfrastructure:\n  db:\n    image: pg\n");
  process.env.SANDBOX_CONFIG_FILE = path.join(dir, "none.yaml");
  process.env.SANDBOX_SERVICES_YAML = yaml;
  ({ applyIssueFormAnswer } = await import("./dist/sandbox.js"));
});

const base = { issue_id: "acme/api#7", task: "Rate limit the API" };

test("a tagged JSON answer fills the known fields and registry services only", async () => {
  const answer =
    'Here you go.\n<result>\n```json\n{"feature":"rate-limit","task":"Rate limit","description":"Cap requests.",' +
    '"starting_prompt":"## Goal\\nCap it.","services":["api","db","api","nope"],"extra":"x"}\n```\n</result>';
  assert.deepEqual(await applyIssueFormAnswer(base, answer), {
    issue_id: "acme/api#7",
    feature: "rate-limit",
    task: "Rate limit",
    description: "Cap requests.",
    starting_prompt: "## Goal\nCap it.",
    services: ["api"],
  });
});

test("a code fence inside a field doesn't hide the JSON around it", async () => {
  const answer = '<result>{"feature":"a-b","starting_prompt":"Run:\\n```bash\\nnpm test\\n```"}</result>';
  assert.deepEqual(await applyIssueFormAnswer(base, answer), {
    ...base,
    feature: "a-b",
    starting_prompt: "Run:\n```bash\nnpm test\n```",
  });
});

test("a feature that isn't a slug is dropped", async () => {
  assert.deepEqual(await applyIssueFormAnswer(base, '<result>{"feature":"Rate Limit!"}</result>'), base);
});

test("no answer, no JSON, or broken JSON leaves the base", async () => {
  for (const answer of [null, "", "sorry, no", "<result>{not json}</result>", "<result>{}</result>"]) {
    assert.deepEqual(await applyIssueFormAnswer(base, answer), base, String(answer));
  }
});
