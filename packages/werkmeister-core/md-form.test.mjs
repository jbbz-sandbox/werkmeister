// SW-309: Markdown question forms — parse, validate, write back, refuse a stale write.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  applyAnswers,
  formBundle,
  formDraft,
  formErrors,
  formHash,
  isQuestionFile,
  parseForm,
  submitForm,
} from "./dist/md_form.js";
import { icmStage } from "./dist/sandbox.js";

// Questions 1 and 2 are the ticket's example verbatim; 3–6 cover the remaining rows.
const MD = `# Decisions

Intro prose is not a question.

## 1. PR-body tables: same exact-cell rule, or move results elsewhere?

status: proposed

- (x) Same exact-cell rule (recommended)
- ( ) Move results out of tables
- ( ) Other:

**Evidence:** resultCells reads every table with a result header…

## 2. Which pipelines get the new wording?

status: proposed

- [x] feature (recommended)
- [ ] bug-fix
- [ ] incident

**Note:**

## 3. Which colour? (optional)

status: proposed

- ( ) red
- ( ) blue (recommended)

## 4. Ship it?

status: proposed

- [ ] Yes

## 5. Which ticket key?

status: proposed

**Key:**

## 6. Already settled

status: decided

- (x) Keep
- ( ) Drop
`;

const form = parseForm(MD);
const q = (n) => form.questions[n - 1];

test("## heading → one question, its label; text above the first ## is not one", () => {
  assert.equal(form.title, "Decisions");
  assert.equal(form.questions.length, 6);
  assert.equal(q(1).heading, "1. PR-body tables: same exact-cell rule, or move results elsewhere?");
  assert.deepEqual(
    form.questions.map((x) => x.key),
    ["q1", "q2", "q3", "q4", "q5", "q6"],
  );
});

test("status: proposed under the heading → open; decided → settled", () => {
  assert.equal(q(1).status, "proposed");
  assert.equal(q(1).statusLine, MD.split("\n").indexOf("status: proposed"));
  assert.equal(q(6).status, "decided");
});

test("- ( ) / - (x) → pick one", () => {
  assert.equal(q(1).kind, "one");
  assert.deepEqual(
    q(1).options.map((o) => [o.value, o.checked]),
    [
      ["Same exact-cell rule", true],
      ["Move results out of tables", false],
      ["Other", false],
    ],
  );
});

test("- [ ] / - [x] → pick any; a single [ ] is a yes/no", () => {
  assert.equal(q(2).kind, "any");
  assert.deepEqual(
    q(2).options.map((o) => [o.value, o.checked]),
    [
      ["feature", true],
      ["bug-fix", false],
      ["incident", false],
    ],
  );
  assert.equal(q(4).kind, "any");
  assert.equal(q(4).options.length, 1);
  assert.deepEqual(formErrors(form, { q4: { picked: [] } }), formErrors(form, {}));
});

test("(recommended) → the agent's pick, pre-ticked in the draft", () => {
  assert.equal(q(1).options[0].recommended, true);
  assert.equal(q(3).options[1].recommended, true);
  assert.deepEqual(formDraft(form).q3.picked, ["blue"]);
  assert.deepEqual(formDraft(form).q1.picked, ["Same exact-cell rule"]);
});

test("Other: → a text box; the text after the colon is its value", () => {
  assert.equal(q(1).options[2].other, true);
  const filled = parseForm(MD.replace("- ( ) Other:", "- ( ) Other: something else"));
  assert.equal(filled.questions[0].options[2].otherText, "something else");
  assert.equal(filled.questions[0].options[2].value, "Other");
});

test("**Label:** with nothing after it → a free-text box", () => {
  assert.deepEqual(
    q(2).boxes.map((b) => b.label),
    ["Note"],
  );
  assert.deepEqual(
    q(5).boxes.map((b) => b.label),
    ["Key"],
  );
  assert.equal(formBundle(form).uiSchema["q2.Note"]["ui:widget"], "textarea");
});

test("**Label:** text and other prose → read-only context", () => {
  assert.deepEqual(q(1).context, [
    "**Evidence:** resultCells reads every table with a result header…",
  ]);
  assert.equal(q(1).boxes.length, 0);
});

test("(optional) heading → not required; others required", () => {
  assert.equal(q(3).required, false);
  assert.equal(q(3).heading, "3. Which colour?");
  assert.equal(q(1).required, true);
});

test("parsing is deterministic: same Markdown, same form and schema", () => {
  assert.deepEqual(parseForm(MD), parseForm(MD));
  assert.equal(
    JSON.stringify(formBundle(parseForm(MD))),
    JSON.stringify(formBundle(parseForm(MD))),
  );
});

test("the bundle covers proposed questions only, in file order", () => {
  const b = formBundle(form);
  assert.deepEqual(b.uiSchema["ui:order"], [
    "q1",
    "q1.other",
    "q2",
    "q2.Note",
    "q3",
    "q4",
    "q5.Key",
  ]);
  assert.deepEqual(b.schema.required, ["q1", "q5.Key"]);
});

test("applyAnswers with no answers returns the file byte for byte", () => {
  assert.equal(applyAnswers(MD, {}), MD);
});

const ANSWERS = {
  q1: { picked: ["Other"], other: "a third way" },
  q2: { picked: ["bug-fix"], boxes: { Note: "line one\nline two" } },
  q5: { boxes: { Key: "SW-1" } },
};

test("applyAnswers changes only marks, Other and label text, and status lines", () => {
  const before = MD.split("\n");
  const out = applyAnswers(MD, ANSWERS);
  const after = out.split("\n");
  const at = (s) => before.indexOf(s);
  // The one line inserted is the Note's second line, right after its label.
  const note = at("**Note:**");
  assert.equal(after[note], "**Note:** line one");
  assert.equal(after[note + 1], "line two");
  const merged = [...after.slice(0, note + 1), ...after.slice(note + 2)];
  assert.equal(merged.length, before.length);
  const changed = merged.flatMap((l, i) => (l === before[i] ? [] : [i]));
  const statuses = before.flatMap((l, i) => (l === "status: proposed" ? [i] : []));
  assert.deepEqual(
    changed,
    [
      statuses[0],
      at("- (x) Same exact-cell rule (recommended)"),
      at("- ( ) Other:"),
      statuses[1],
      at("- [x] feature (recommended)"),
      at("- [ ] bug-fix"),
      note,
      statuses[4],
      at("**Key:**"),
    ].sort((a, b) => a - b),
  );
  assert.equal(merged[at("- ( ) Other:")], "- (x) Other: a third way");
  assert.equal(
    merged[at("- (x) Same exact-cell rule (recommended)")],
    "- ( ) Same exact-cell rule (recommended)",
  );
  assert.equal(merged[at("**Key:**")], "**Key:** SW-1");
  // q3 and q4 were not answered: still proposed.
  assert.equal(parseForm(out).questions[2].status, "proposed");
});

test("applyAnswers keeps CRLF line endings", () => {
  const crlf = MD.replaceAll("\n", "\r\n");
  assert.equal(applyAnswers(crlf, {}), crlf);
  const out = applyAnswers(crlf, ANSWERS);
  assert.equal(out, applyAnswers(MD, ANSWERS).replaceAll("\n", "\r\n"));
});

test("a hand-edited file parses the same as one written by Submit", () => {
  const byHand = MD.replace("- (x) Same exact-cell rule", "- ( ) Same exact-cell rule")
    .replace("- ( ) Move results", "- (x) Move results")
    .replace("status: proposed", "status: decided");
  const bySubmit = applyAnswers(MD, { q1: { picked: ["Move results out of tables"] } });
  assert.deepEqual(parseForm(byHand), parseForm(bySubmit));
});

test("formErrors: required rejected, optional not, Other needs text, unknown keys rejected", () => {
  assert.deepEqual(formErrors(form, { q5: { boxes: { Key: "SW-1" } } }), { q1: "required" });
  const ok = { q1: { picked: ["Same exact-cell rule"] }, q5: { boxes: { Key: "SW-1" } } };
  assert.deepEqual(formErrors(form, ok), {});
  assert.deepEqual(formErrors(form, { ...ok, q1: { picked: ["Other"], other: " " } }), {
    "q1.other": "required",
  });
  assert.deepEqual(formErrors(form, { ...ok, q6: { picked: ["Drop"] } }), {
    q6: "not a proposed question",
  });
  assert.deepEqual(formErrors(form, { ...ok, q3: { picked: ["green"] } }), {
    q3: "not offered: green",
  });
});

function tmpFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-form-"));
  const file = path.join(dir, "question-x.md");
  fs.writeFileSync(file, text);
  return file;
}

test("submitForm writes the answers and flips every proposed question to decided", async () => {
  const file = tmpFile(MD);
  const r = await submitForm(file, ANSWERS, formHash(MD));
  assert.equal(r.decided.length, 5);
  const written = parseForm(fs.readFileSync(file, "utf-8"));
  assert.ok(written.questions.every((x) => x.status === "decided"));
  assert.equal(written.questions[0].options[2].otherText, "a third way");
});

test("submitForm refuses, and says why, when the file changed after the form was rendered", async () => {
  const file = tmpFile(MD);
  const hash = formHash(MD);
  const edited = MD.replace("**Note:**", "**Note:** typed in an editor");
  fs.writeFileSync(file, edited);
  await assert.rejects(submitForm(file, ANSWERS, hash), /changed after the form was shown/);
  assert.equal(fs.readFileSync(file, "utf-8"), edited);
});

test("submitForm refuses invalid answers and leaves the file alone", async () => {
  const file = tmpFile(MD);
  await assert.rejects(submitForm(file, {}, formHash(MD)), /q1: required/);
  assert.equal(fs.readFileSync(file, "utf-8"), MD);
});

test("question-*.md files never count as a stage's artifact", async () => {
  assert.ok(isQuestionFile("question-approval.md"));
  assert.ok(!isQuestionFile("decisions.md"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "md-form-ws-"));
  for (const [stage, file] of [
    ["01_research", "decisions.md"],
    ["02_spec", "question-approval.md"],
    ["03_implement", ".gitkeep"],
  ]) {
    fs.mkdirSync(path.join(ws, "stages", stage, "output"), { recursive: true });
    fs.writeFileSync(path.join(ws, "stages", stage, "output", file), "x");
  }
  assert.deepEqual(await icmStage(ws), { index: 2, total: 3, name: "spec" });
});
