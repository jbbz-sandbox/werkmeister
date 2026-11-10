// Every work type the wizard offers (WORK_TYPE_PHASES) has an icm template,
// and each renders without holes.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { ICM_TEMPLATES, templateFor } from "./dist/strategies/icm_templates.js";
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
              : /`output\/repro\.md`: steps 1–7/,
            `${wt}/${d}`,
          );
        } else {
          assert.doesNotMatch(c, /git log -S/, `${wt}/${d}`);
        }
        // SW-442: reproduce lists each case of a fix's predicate, each with a test.
        if (d.endsWith("_reproduce"))
          assert.match(
            c,
            /When the proposed fix branches on a predicate, list each condition that makes it true and give each one a test\./,
            `${wt}/${d}`,
          );
        // SW-365: research lists whole-module mocks of a module that gains an export.
        if (d.endsWith("_research"))
          assert.match(
            c,
            /^1\. List what exists.*whole-module mocks.*fixture the change must update/m,
            `${wt}/${d}`,
          );
        // SW-242: research greps tests and fixtures for the exact value being changed.
        if (d.endsWith("_research"))
          assert.match(
            c,
            /^1\. List what exists.*grep tests and fixtures for that exact value and list the hits/m,
            `${wt}/${d}`,
          );
        // Research checks an external tool's facts against the installed tool, not its docs.
        if (d.endsWith("_research"))
          assert.match(
            c,
            /^3\. Check what is already installed.*against the installed tool.*`unverified: docs only`/m,
            `${wt}/${d}`,
          );
        // SW-534: an exercise that changes code gets the review rerun on its delta.
        if (d.endsWith("_implement"))
          assert.match(c, /rerun the review on that delta/, `${wt}/${d}`);
        // SW-535: follow-ups promised in decisions.md are filed before the PR file.
        if (d.endsWith("_propose"))
          assert.match(
            c,
            /^\d+\. Before the PR file: .*file it through `\.\.\/\.\.\/_shared\/issues-report\.md`/m,
            `${wt}/${d}`,
          );
        // SW-415: a repo without repo.lint has no `&& <lint>` tail.
        if (d.endsWith("_propose"))
          assert.match(
            c,
            /the `&& <lint>` tail of the test command in `werkmeister-context\.md`, when it has one,/,
            `${wt}/${d}`,
          );
        // SW-288: spec loads the standards its files hit and lists ticket-vs-standard conflicts.
        if (d.endsWith("_spec"))
          assert.match(
            c,
            /^4\. Load every `_shared\/standards\.md` row whose Applies-when matches a file `spec\.md` changes.*`## Conflicts`/m,
            `${wt}/${d}`,
          );
        // SW-111: spec asks how an existing user turns the change on.
        if (d.endsWith("_spec"))
          assert.match(c, /^5\. .*how does an existing user turn this on\?/m, `${wt}/${d}`);
        // SW-543: call sites come from every entry point, with the greps recorded; the generic text names no werkmeister helper.
        if (d.endsWith("_reproduce")) {
          assert.match(
            c,
            /^4\. .*list its call sites through every helper or entry point that reaches that code, not one argument shape, and record the search commands \(greps\) you used in `repro\.md`/m,
            `${wt}/${d}`,
          );
          assert.doesNotMatch(c, /runCapture|execRun|childEnv|execFileSync|runAsync/, `${wt}/${d}`);
        }
        // SW-562: stages that write exercise.md collect each MANUAL row's result before approval.
        if (c.includes("Write `output/exercise.md`"))
          assert.match(
            c,
            /Before asking for approval, list the exercise rows only a person can run .* one question per row \(pass \/ fail \/ not run\).*`MANUAL: not run \(person's reason\)`/,
            `${wt}/${d}`,
          );
        // SW-579: the bugfix review step rewrites exercise.md, so the MANUAL step comes before it; elsewhere it follows the exercise.md write.
        if (c.includes("Write `output/exercise.md`")) {
          const manual = c.indexOf("Before asking for approval, list the exercise rows");
          const review = c.indexOf("Review the diff: for each code worktree");
          if (d.endsWith("_exercise")) assert.ok(manual > -1 && manual < review, `${wt}/${d}`);
          else assert.ok(manual > c.indexOf("Write `output/exercise.md`"), `${wt}/${d}`);
        }
        // SW-653: the plan stages say commits belong to a later stage (the grouped text is asserted in the group test).
        if (/_(spec|reproduce|scope)$/.test(d))
          assert.match(
            c,
            /Code changes stay uncommitted until the propose stage, so plan the work and its checks, not commits\./,
            `${wt}/${d}`,
          );
        // SW-564: a permission-rule root cause lists every source of a matching rule.
        if (d.endsWith("_reproduce"))
          assert.match(
            c,
            /^7\. When the root cause is a permission rule \(allow, deny, ask\), step 4 lists every source of a matching rule:.*`--allowedTools` \/ `--disallowedTools`\)\. The failing test probes each source\./m,
            `${wt}/${d}`,
          );
        // SW-566: step 4 also lists what each caller does with the result.
        if (d.endsWith("_reproduce"))
          assert.match(
            c,
            /^4\. List every other caller .* and what each does with the result \(an early return, a printed value, a stored state\), so the fix's return shape is checked against every caller before the fix stage/m,
            `${wt}/${d}`,
          );
        // SW-392: a repro is judged by exit code, not an output grep.
        if (d.endsWith("_reproduce"))
          assert.match(c, /^1\. Reproduce .*Judge each run by its exit code/m, `${wt}/${d}`);
        // SW-124: every test step, and the subagents it briefs, go through the wrapper.
        if (c.includes("Run the test command")) {
          assert.match(c, /through `\.werkmeister\/bin\/with-temp-home`/, `${wt}/${d}`);
          assert.match(c, /A subagent you brief to run tests/, `${wt}/${d}`);
          // SW-316: the host run misses the container env; the tests-only gate runs where pr open will.
          assert.match(c, /without the container's env \(`HOST`, `WERKMEISTER_SLOT`/, `${wt}/${d}`);
          assert.match(c, /run `werkmeister pr gate --tests`/, `${wt}/${d}`);
          // SW-334: the redirect wraps the whole && chain, not its last command.
          // SW-526: a background job's notice carries the exit code, so its pattern has no trailing echo.
          assert.ok(c.includes("background: `{ <test command>; } > <log> 2>&1`"), `${wt}/${d}`);
          assert.match(c, /read the exit code from the job's completion notice/, `${wt}/${d}`);
          assert.ok(
            c.includes('foreground: `{ <test command>; } > <log> 2>&1; echo "exit $?"`'),
            `${wt}/${d}`,
          );
          // SW-351: the diff is read against the settled edits before the tests run.
          assert.match(
            c,
            /read `git diff` in each repo you touched and tick off each edit `(spec|repro|scope)\.md` settled/,
            `${wt}/${d}`,
          );
          assert.ok(
            c.indexOf("tick off each edit") < c.indexOf("Run the test command"),
            `${wt}/${d}: diff check before tests`,
          );
          // SW-547, SW-646: the repo's own format command runs on the touched files before the tests.
          assert.match(
            c,
            /gives the repo a format command[^\n]*first run it on the files you touched \(never a folder\)/,
            `${wt}/${d}`,
          );
          assert.doesNotMatch(c, /\b(pnpm|biome|turbo|changesets?)\b/, `${wt}/${d}`);
          assert.ok(
            c.indexOf("format command") < c.indexOf("Run the test command"),
            `${wt}/${d}: format before tests`,
          );
          // SW-125: skips are named in the test step and in the file that records the run.
          assert.match(c, /A skipped test is not a pass: name each one/, `${wt}/${d}`);
          assert.match(
            c,
            /Write `output\/(fix|exercise)\.md`:[^\n]*every skipped test by name with its skip reason and where it ran instead/,
            `${wt}/${d}`,
          );
        }
        // SW-143: every exercise step defers a library/CLI to its Validation text, and the
        // templates stay app-agnostic — the werkmeister recipe lives in its services.yaml.
        if (c.includes("Reload")) {
          assert.match(c, /A library or CLI has no service to restart/, `${wt}/${d}`);
          assert.match(c, /as its Validation text in `werkmeister-context\.md`/, `${wt}/${d}`);
        }
        // SW-506: the host-test step yields to a container recipe in the service's validate text.
        if (c.includes("through `.werkmeister/bin/with-temp-home`, which gives"))
          assert.match(
            c,
            /says to run in its container \(`docker exec`\), follow that text instead/,
            `${wt}/${d}`,
          );
        // SW-388: each build stage ends with the review step and lists review.md; spike has none.
        const build = { feature: "03_implement", refactor: "02_implement" }[wt] ?? "03_exercise";
        if (wt !== "spike" && d === build) {
          assert.match(c, /`ponytail:ponytail-review`/, `${wt}/${d}`);
          // SW-505: the gate reads review.md as a result table; say so where it is named.
          assert.match(
            c,
            /`\| criterion \| result \| evidence \|`[^\n]*`PASS` or `FAIL`/,
            `${wt}/${d}`,
          );
          assert.match(c, /has no PASS row/, `${wt}/${d}`);
          // SW-431: the brief asks what a newly pre-approved command can reach, in generic text (SW-143).
          assert.match(
            c,
            /If the change adds or widens an allow rule or another pre-approved command, add to the brief: "this change pre-approves a command/,
            `${wt}/${d}`,
          );
          assert.doesNotMatch(c, /buildAllowRules|\.werkmeister\/bin\/\*/, `${wt}/${d}`);
          // SW-479: reaching the host daemon, the real ~/.werkmeister or another workspace is Must fix.
          assert.match(
            c,
            /Always add: "any finding where the change can restart or write the host daemon, the real `~\/\.werkmeister` or another workspace, whether through an allow rule, a script or a test, is Must fix"/,
            `${wt}/${d}`,
          );
          // SW-449: a Should fix that shows the change's own text is false is fixed, not left.
          assert.match(
            c,
            /and any \*\*Should fix\*\* finding that shows the change's own docs, comments, help text or release entry state something false \(fix the code, or reword that text so it is true\)/,
            `${wt}/${d}`,
          );
          assert.match(
            c,
            /## Outputs[\s\S]*^- `output\/review\.md`: a `\| criterion \| result \| evidence \|` table, result exactly `PASS` or `FAIL`, its first line `status: proposed`$/m,
            `${wt}/${d}`,
          );
          if (d.endsWith("_implement")) {
            // SW-430: host tests → review and fix → the gate, once → exercise.md.
            const order = [
              "Run the test command",
              "Review the diff",
              "Once the review's fixes are in, run `werkmeister pr gate --tests`",
              "Write `output/exercise.md`",
            ].map((s) => c.indexOf(s));
            assert.ok(
              order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])),
              `${wt}/${d}: ${order}`,
            );
          } else
            assert.ok(
              c.indexOf("Review the diff") > c.indexOf("Write `output/exercise.md`"),
              `${wt}/${d}: review after exercise.md`,
            );
          assert.match(
            c,
            /Reference \(every run\): `\.\.\/\.\.\/_shared\/standards\.md`/,
            `${wt}/${d}`,
          );
        } else {
          assert.doesNotMatch(c, /review\.md/, `${wt}/${d}`);
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
        // SW-399: lint runs after the release entry is added, before the commit.
        if (d.endsWith("_propose"))
          assert.match(
            c,
            /^2\. .*add the release entry.*Before committing, run the repo's lint command/m,
            `${wt}/${d}`,
          );
        if (d.endsWith("_propose"))
          assert.match(
            c,
            /the gate reads them all — has a result cell of exactly `PASS` and .*a FAIL cell anywhere in the PR file stops the PR/,
            `${wt}/${d}`,
          );
      }
      // SW-331: a stage that reads `BRIEF.md` § Acceptance criteria has a first stage that writes it.
      const first = fs.readFileSync(path.join(root, "stages", dirs[0], "CONTEXT.md"), "utf8");
      assert.match(
        first,
        /^0\. If `\.\.\/\.\.\/BRIEF\.md` has no `## Acceptance criteria` section, write/m,
        wt,
      );
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

/** Init an icm workspace (feature unless *extra* says otherwise) at *root* with *autonomous*; returns what it wrote. */
async function initIcm(root, standardsDir, autonomous, extra = {}) {
  await withSandboxHome(
    () =>
      withReporter(collectingReporter(), async () =>
        strategyById("icm").init({
          workspaceRoot: root,
          workspaceName: "demo",
          repos: [["repo", "me/demo"]],
          task: "t",
          meta: { FEATURE: "demo", SERVICES: "api" },
          inputs: { work_type: "feature", starting_prompt: "p", autonomous, ...extra },
          configOverride: null,
        }),
      ),
    { config: `overrides:\n  standards_dir: ${standardsDir}\n` },
  );
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const stages = fs.readdirSync(path.join(root, "stages")).sort();
  return {
    claude: read(fs.existsSync(path.join(root, "AGENTS.md")) ? "AGENTS.md" : "CLAUDE.md"),
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
        "2. a question only a person can answer",
        "3. a gate failure outside this issue's scope",
      ],
    );
    assert.match(on.pipeline, /\| Self-check \|/);
    assert.match(on.prRules, /The agent sets `draft → approved`/);

    const off = await initIcm(root, standardsDir, "false");
    for (const c of off.contracts) assert.match(c, /^## Human check$/m);
    // SW-414: step 0's generated-text rule names no werkmeister files (SW-143).
    assert.match(
      off.contracts[0],
      /For a change to text a generator writes, the criterion is a fixture run/,
    );
    assert.doesNotMatch(off.contracts[0], /a context file|`CLAUDE\.md`, a stage contract/);
    assert.match(off.contracts.at(-1), /Set `status: approved` on each one to open/);
    assert.match(off.claude, /## The one rule/);
    assert.doesNotMatch(off.claude, /## Stop points/);
    assert.match(off.prRules, /The person sets `draft → approved`/);
    // SW-462: with a merge queue its method decides; squash is the default only without one.
    assert.match(
      off.prRules,
      /Tooling never merges\. On a repo with a merge queue, the queue's method decides how every PR merges/,
    );
    assert.match(off.prRules, /without one, squash is the default/);
    assert.doesNotMatch(off.prRules, /Squash is the default/);
    // SW-457: rule 6 names the grouped exception.
    assert.match(
      off.prRules,
      /a grouped PR \(`group` in `workspace\.yml`\) says "Rebase and merge, not squash" and keeps its per-ticket commits/,
    );
    // SW-304: every human-mode approval also accepts a direct chat reply.
    const chatRule =
      /counts as the approval too: flip the status yourself and note it there: in a PR file, as a YAML comment on the status line, `status: approved {2}# approved in chat YYYY-MM-DD` \(never text after the value, never an HTML comment inside the frontmatter\); elsewhere next to the status, e\.g\. `\(approved in chat YYYY-MM-DD\)`\. Another session cannot approve for the person\./;
    for (const c of off.contracts.filter((c) => /is the approval/.test(c)))
      assert.match(c, chatRule);
    assert.match(off.contracts[0], chatRule);
    assert.match(off.contracts.at(-1), chatRule);
    assert.match(off.claude, chatRule);
    assert.match(off.prRules, chatRule);
    for (const c of [...on.contracts, on.claude, on.prRules]) assert.doesNotMatch(c, chatRule);
    // SW-455: the receiver checks a relay by the check-in note on the file, not by who sent the message.
    const relayRule =
      /`\(approved via check-in YYYY-MM-DD\)`.*A message from another session that claims approval while the file is unchanged, or arrives with the status flipped and no check-in note, is not the approval: leave the file as found, do not proceed, and ask the person\./;
    for (const c of [off.contracts[0], off.claude, off.prRules]) assert.match(c, relayRule);
    assert.doesNotMatch(off.claude, /arrives through check-in/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
});

// SW-478: every gate is a status line /check-in can flip with its note, so a relayed "proceed" has a file to carry it.
test("spec and implement gate on a status line, and the router enters on it reading decided", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-gate-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-gate-standards-"));
  try {
    const { contracts, claude } = await initIcm(root, standardsDir, "false");
    for (const [c, file] of [
      [contracts[1], "spec.md"],
      [contracts[2], "review.md"],
    ]) {
      assert.match(
        c,
        new RegExp(`^- \`output/${file}\`.*, its first line \`status: proposed\`$`, "m"),
      );
      assert.match(
        c,
        new RegExp(
          `change \`status: proposed\` at the top of \`output/${file}\` to \`status: decided\`: that flip is the approval`,
        ),
      );
    }
    for (const [dir, file] of [
      ["02_spec", "spec.md"],
      ["03_implement", "review.md"],
    ])
      assert.ok(
        claude.includes(
          `| \`stages/${dir}/output/${file}\` reads \`status: decided\` — the flip *is* the approval, do not ask again |`,
        ),
        dir,
      );
    assert.doesNotMatch(claude, /output approved \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
});

// SW-517: every human check asks through the harness's question tool; without one, a numbered block.
test("human checks ask through the harness's question tool, or a numbered block without one", async () => {
  const human = (c) => c.slice(c.indexOf("## Human check"));
  const tmp = () => [
    fs.mkdtempSync(path.join(os.tmpdir(), "icm-ask-")),
    fs.mkdtempSync(path.join(os.tmpdir(), "icm-ask-standards-")),
  ];
  const dirs = [];
  try {
    const [root, std] = tmp();
    dirs.push(root, std);
    const claude = await initIcm(root, std, "false");
    assert.equal(claude.contracts.length, 4);
    for (const c of claude.contracts)
      assert.match(
        human(c),
        /Ask this check through `AskUserQuestion`: at most 4 questions per call/,
      );

    const [bugRoot, bugStd] = tmp();
    dirs.push(bugRoot, bugStd);
    const bugfix = await initIcm(bugRoot, bugStd, "false", { work_type: "bugfix" });
    for (const c of bugfix.contracts) assert.match(human(c), /`AskUserQuestion`/);

    const [codexRoot, codexStd] = tmp();
    dirs.push(codexRoot, codexStd);
    fs.mkdirSync(path.join(codexRoot, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(codexRoot, ".werkmeister", "workspace.yml"), "harness: codex\n");
    const codex = await initIcm(codexRoot, codexStd, "false");
    for (const c of codex.contracts) {
      assert.match(human(c), /Ask this check as one numbered block at the end of your reply/);
      assert.doesNotMatch(c, /AskUserQuestion/);
    }

    const [autoRoot, autoStd] = tmp();
    dirs.push(autoRoot, autoStd);
    const auto = await initIcm(autoRoot, autoStd, "true");
    for (const c of auto.contracts) assert.doesNotMatch(c, /Ask this check/);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

// SW-438: `group` in workspace.yml marks a grouped PR; unset keeps the uncommitted-diff contracts.
test("group renders per-ticket commits, a range review and kept commits; unset keeps today's text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icm-group-"));
  const standardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "icm-group-standards-"));
  try {
    const on = await initIcm(root, standardsDir, "false", { group: "SW-2,SW-3" });
    const [, , implement, propose] = on.contracts;
    assert.match(
      implement,
      /one commit per ticket, for the workspace's issue and each member, `SW-2`, `SW-3`/,
    );
    assert.match(implement, /commits in `origin\/main\.\.\.HEAD`/);
    // SW-466: each ticket's commit carries its own snapshot regeneration.
    assert.match(implement, /regenerate it in that ticket's commit/);
    // SW-503: each ticket's release entry goes in that ticket's own commit, in the build and propose stages.
    assert.match(implement, /carries its release entry in its own commit/);
    assert.match(propose, /each ticket's release entry into that ticket's own commit/);
    // SW-497: order across tickets is free; the spec does not fix it.
    assert.match(implement, /Commit order across tickets is free/);
    assert.match(
      on.contracts[1],
      /list one commit per ticket \(`<KEY> …`\) and what each holds, but do not fix their order/,
    );
    assert.match(
      implement,
      /fold each fix into the commit of the ticket it belongs to \(`git commit --fixup <sha>`/,
    );
    assert.match(implement, /^- Code changes, one commit per ticket/m);
    assert.match(implement, /Read each ticket's commit/);
    assert.doesNotMatch(
      implement,
      /uncommitted changes, untracked files included|Code changes, uncommitted/,
    );
    assert.doesNotMatch(propose, /One commit per code repo touched/);
    assert.match(propose, /never squash to one per repo/);
    // The fold keeps the base; lint runs before it so its fixes land in a commit.
    assert.match(propose, /git rebase --autosquash \$\(git merge-base HEAD origin\/main\)/);
    assert.ok(
      propose.indexOf("Run the repo's lint command") <
        propose.indexOf("Then fold everything uncommitted"),
      "lint before fold",
    );
    assert.match(propose, /Rebase and merge, not squash/);
    assert.match(
      propose,
      /check each member reads Done — `werkmeister issue view <KEY>` for `SW-2`, `SW-3`/,
    );
    assert.match(on.pipeline, /one per ticket in a grouped PR/);
    // SW-653: a grouped spec leaves the per-ticket commits to implement and never says code stays uncommitted.
    assert.match(
      on.contracts[1],
      /The implement stage makes those commits; plan the work and its checks, not finer commits\./,
    );
    assert.doesNotMatch(on.contracts[1], /stay uncommitted until the propose stage/);
    // SW-460: a grouped refactor nests scope.md's steps inside each ticket's commit.
    const refactorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "icm-group-refactor-"));
    try {
      const refactor = await initIcm(refactorRoot, standardsDir, "false", {
        group: "SW-2,SW-3",
        work_type: "refactor",
      });
      const implement = refactor.contracts.find((c) => /^# 02_implement/m.test(c));
      assert.match(
        implement,
        /For each ticket, take its `scope\.md` steps in order, then commit it before the next ticket; do not commit after every step\./,
      );
      assert.doesNotMatch(implement, /Take the steps in order\. After each one/);
      for (const c of refactor.contracts) assert.doesNotMatch(c, /once,? at the end/);
      // SW-467: 01_scope nests the steps under each ticket key.
      const scope = refactor.contracts.find((c) => /^# 01_scope/m.test(c));
      assert.match(
        scope,
        /under one heading per ticket key \(the workspace's issue, then `SW-2`, `SW-3`\)/,
      );
    } finally {
      fs.rmSync(refactorRoot, { recursive: true, force: true });
    }

    const auto = await initIcm(root, standardsDir, "true", { group: "SW-2" });
    assert.match(auto.contracts.at(-1), /When the PR ships, check each member reads Done/);

    const bugRoot = fs.mkdtempSync(path.join(os.tmpdir(), "icm-group-bugfix-"));
    try {
      const bug = await initIcm(bugRoot, standardsDir, "false", {
        group: "SW-2",
        work_type: "bugfix",
      });
      assert.match(bug.contracts[1], /one commit per ticket/);
      assert.match(bug.contracts[2], /commits in `origin\/main\.\.\.HEAD`/);
      for (const c of bug.contracts) assert.doesNotMatch(c, /once,? at the end/);
    } finally {
      fs.rmSync(bugRoot, { recursive: true, force: true });
    }

    const off = await initIcm(root, standardsDir, "false");
    assert.match(off.contracts[2], /uncommitted changes, untracked files included/);
    assert.match(off.contracts[2], /^- Code changes, uncommitted/m);
    assert.match(off.contracts[3], /One commit per code repo touched/);
    assert.doesNotMatch(off.contracts[1], /do not fix their order/);
    for (const c of [...on.contracts, ...off.contracts])
      assert.doesNotMatch(c, /once,? at the end/);
    for (const c of off.contracts)
      assert.doesNotMatch(c, /grouped PR|origin\/main\.\.\.HEAD|each member reads Done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(standardsDir, { recursive: true, force: true });
  }
});
