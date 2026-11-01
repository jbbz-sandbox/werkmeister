// Every work type the wizard offers (WORK_TYPE_PHASES) has an icm template,
// and each renders without holes.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { ICM_TEMPLATES, QUESTION_RULE, templateFor } from "./dist/strategies/icm_templates.js";
import { strategyById } from "./dist/strategies/index.js";
import { WORK_TYPE_PHASES } from "./dist/workspace_prompts.js";
import { withSandboxHome } from "./fixtures.mjs";

const EXPECTED = {
  feature: ["research", "spec", "implement", "propose"],
  bugfix: ["reproduce", "fix", "exercise", "propose"],
  incident: ["reproduce", "fix", "exercise", "propose"],
  refactor: ["scope", "implement", "propose"],
  spike: ["questions", "findings"],
};

test("every wizard work type has its template", () => {
  for (const wt of Object.keys(WORK_TYPE_PHASES)) {
    assert.ok(Object.hasOwn(ICM_TEMPLATES, wt), `no icm template for ${wt}`);
    assert.deepEqual(
      templateFor(wt).map((s) => s.name),
      EXPECTED[wt],
      wt,
    );
  }
});

// Task 3's trim/lowercase normalisation was only pinned by `feature` while it
// was the only template. Now that `bugfix` exists too, this fails if the
// normalisation is ever dropped.
test("templateFor normalises free-text casing and whitespace", () => {
  assert.deepEqual(
    templateFor(" Bugfix ").map((s) => s.name),
    EXPECTED["bugfix"],
  );
});

test("each template renders with no undefined and a route per stage", async () => {
  for (const wt of Object.keys(EXPECTED)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${wt}-`));
    // Empty standards tree in a temp dir: without this override, withSandboxHome
    // would fall through to the developer's real standards_dir and read their
    // actual standards tree instead of a hermetic empty one.
    const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${wt}-standards-`));
    try {
      await withSandboxHome(
        () =>
          withReporter(collectingReporter(), async () =>
            strategyById("icm").init({
              workspaceRoot: root,
              workspaceName: "demo",
              repos: [["repo", "me/demo"]],
              task: "t",
              meta: { FEATURE: "demo", SERVICES: "api" },
              inputs: { work_type: wt, starting_prompt: "p" },
              hasServiceMap: false,
              configOverride: null,
            }),
          ),
        { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
      );
      const dirs = fs.readdirSync(path.join(root, "stages")).sort();
      assert.deepEqual(
        dirs,
        EXPECTED[wt].map((n, i) => `0${i + 1}_${n}`),
        wt,
      );
      const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      assert.ok(claude.split("\n").length <= 60, `${wt}: CLAUDE.md over 60 lines`);
      for (const d of dirs) {
        assert.match(claude, new RegExp(`stages/${d}/CONTEXT\\.md`), `${wt}: no route to ${d}`);
        const c = fs.readFileSync(path.join(root, "stages", d, "CONTEXT.md"), "utf8");
        assert.doesNotMatch(c, /undefined/, `${wt}/${d}`);
        // SW-123: only the two stages that settle decisions carry the name-history step.
        if (d.endsWith("_research") || d.endsWith("_reproduce")) {
          assert.match(c, /definition site \(file and line\)/, `${wt}/${d}`);
          assert.match(c, /`git log -S <name>`/, `${wt}/${d}`);
          assert.match(c, /list "remove" as an option/, `${wt}/${d}`);
          assert.match(
            c,
            d.endsWith("_research")
              ? /evidence from steps 1–3 and 5/
              : /`output\/repro\.md`: steps 1–5/,
            `${wt}/${d}`,
          );
        } else {
          assert.doesNotMatch(c, /git log -S/, `${wt}/${d}`);
        }
        // SW-124: every test step, and the subagents it briefs, go through the wrapper.
        if (c.includes("Run the test command")) {
          assert.match(c, /through `\.werkmeister\/bin\/with-temp-home`/, `${wt}/${d}`);
          assert.match(c, /A subagent you brief to run tests/, `${wt}/${d}`);
        }
        // SW-143: every exercise step defers a library/CLI to its Validation text, and the
        // templates stay app-agnostic — the werkmeister recipe lives in its services.yaml.
        if (c.includes("Reload")) {
          assert.match(c, /A library or CLI has no service to restart/, `${wt}/${d}`);
          assert.match(c, /as its Validation text in `werkmeister-context\.md`/, `${wt}/${d}`);
        }
        assert.doesNotMatch(c, /WERKMEISTER_CONFIG_FILE|skills check/, `${wt}/${d}`);
        // SW-286: every exercise.md writer states the exact-cell rule the gate enforces.
        if (c.includes("Write `output/exercise.md`")) {
          const col = d.endsWith("_exercise") ? "detail" : "evidence";
          assert.ok(c.includes(`\`| check | result | ${col} |\``), `${wt}/${d}`);
          assert.match(c, /result cell is exactly `PASS` or `FAIL` — nothing else/, `${wt}/${d}`);
          assert.match(c, /every table in `exercise\.md`/, `${wt}/${d}`);
          assert.match(c, /superseded run in prose, not as a `FAIL` row/, `${wt}/${d}`);
        }
        if (d.endsWith("_propose"))
          assert.match(
            c,
            /the gate reads them all — has a result cell of exactly `PASS` or `FAIL`/,
            `${wt}/${d}`,
          );
      }
      if (EXPECTED[wt].includes("exercise")) {
        const ex = fs.readFileSync(path.join(root, "stages", "03_exercise", "CONTEXT.md"), "utf8");
        assert.match(ex, /A library or CLI has no service to restart/, `${wt}/03_exercise`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(standardsDir, { recursive: true, force: true });
    }
  }
});

/** Init a feature-template icm workspace at *root* with *autonomous*; returns what it wrote. */
async function initIcm(root, standardsDir, autonomous) {
  await withSandboxHome(
    () =>
      withReporter(collectingReporter(), async () =>
        strategyById("icm").init({
          workspaceRoot: root,
          workspaceName: "demo",
          repos: [["repo", "me/demo"]],
          task: "t",
          meta: { FEATURE: "demo", SERVICES: "api" },
          inputs: { work_type: "feature", starting_prompt: "p", autonomous },
          configOverride: null,
        }),
      ),
    { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
  );
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const stages = fs.readdirSync(path.join(root, "stages")).sort();
  return {
    claude: read("CLAUDE.md"),
    pipeline: read("CONTEXT.md"),
    prRules: read("_shared/pr-rules.md"),
    contracts: stages.map((d) => read(`stages/${d}/CONTEXT.md`)),
  };
}

// #175: autonomous moves the person's review to the PR; flipping it off restores every human check.
test("autonomous renders self-checks and stop points, and turning it off restores the human checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-autonomous-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-autonomous-standards-"));
  try {
    const on = await initIcm(root, standardsDir, "true");
    for (const c of on.contracts) {
      assert.match(c, /^## Self-check$/m);
      assert.doesNotMatch(c, /## Human check/);
    }
    assert.match(
      on.contracts.at(-1),
      /set `status: approved` yourself and run `werkmeister pr open` detached, as `_shared\/pr-rules\.md` rule 3 shows\. Stop at the PR URL\./,
    );
    assert.match(on.contracts[0], /## Recommendations for reviewer/);
    assert.match(on.claude, /## Stop points/);
    assert.doesNotMatch(on.claude, /The one rule|a person has read/);
    assert.deepEqual(
      on.claude.split("\n").filter((l) => /^\d\. /.test(l)),
      [
        "1. the PR URL from `werkmeister pr open`",
        `2. ${QUESTION_RULE}`,
        "3. a gate failure outside this issue's scope",
      ],
    );
    assert.match(on.pipeline, /\| Self-check \|/);
    assert.match(on.prRules, /The agent sets `draft → approved`/);

    const off = await initIcm(root, standardsDir, "false");
    for (const c of off.contracts) assert.match(c, /^## Human check$/m);
    assert.match(off.contracts.at(-1), /Set `status: approved` on each one to open/);
    assert.match(off.claude, /## The one rule/);
    assert.doesNotMatch(off.claude, /## Stop points/);
    assert.match(off.prRules, /The person sets `draft → approved`/);
    // SW-304: every human-mode approval also accepts a direct chat reply, and a relay only via check-in.
    const chatRule =
      /counts as the approval too: flip the status yourself and note it there, e\.g\. `\(approved in chat YYYY-MM-DD\)`\. An approval relayed by another session counts only when it arrives through check-in\./;
    for (const c of off.contracts.filter((c) => /is the approval/.test(c)))
      assert.match(c, chatRule);
    assert.match(off.contracts[0], chatRule);
    assert.match(off.contracts.at(-1), chatRule);
    assert.match(off.claude, chatRule);
    assert.match(off.prRules, chatRule);
    for (const c of [...on.contracts, on.claude, on.prRules]) assert.doesNotMatch(c, chatRule);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
});

// SW-309: questions and stage approvals are Markdown forms answered on the /workspaces pane's workspace cards.
test("human mode: decisions.md is a form, each later stage ends with an approval form, questions go to files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-forms-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-forms-standards-"));
  try {
    const off = await initIcm(root, standardsDir, "false");
    const [research, spec, implement, propose] = off.contracts;
    assert.match(research, /Write `output\/decisions\.md` as a form\. Form syntax:/);
    assert.match(research, /`- \( \)` pick one, `- \[ \]` pick any/);
    assert.match(
      research,
      /Answer `output\/decisions\.md` on its workspace card in the \/workspaces pane/,
    );
    assert.doesNotMatch(research, /question-approval\.md/);
    for (const [dir, c] of [
      ["02_spec", spec],
      ["03_implement", implement],
    ]) {
      assert.match(
        c,
        new RegExp(`Last, write \`output/question-approval\\.md\`: \`# Approve ${dir}\``),
      );
      assert.match(c, /^- `output\/question-approval\.md`$/m);
      assert.match(c, /\(x\) Approve` with `status: decided` is the approval/);
    }
    // propose keeps the PR file's `status: approved` as its gate.
    assert.doesNotMatch(propose, /question-approval/);
    assert.match(
      off.claude,
      /\| `stages\/02_spec\/output\/question-approval\.md` reads `status: decided` with `\(x\) Approve` — the flip \*is\* the approval, do not ask again \| `stages\/03_implement\/CONTEXT\.md` \|/,
    );
    assert.match(
      off.claude,
      /\| `stages\/03_implement\/output\/question-approval\.md` reads `status: decided` with `\(x\) Changes needed` \|/,
    );
    assert.match(
      off.claude,
      /a `stages\/\*\/output\/question-\*\.md` you wrote reads `status: decided`/,
    );
    assert.ok(off.claude.includes(QUESTION_RULE));
    assert.match(off.pipeline, /`\.gitkeep` and `question-\*\.md` do not count/);

    const on = await initIcm(root, standardsDir, "true");
    for (const c of on.contracts) assert.doesNotMatch(c, /question-approval/);
    assert.doesNotMatch(on.claude, /question-approval/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
});
