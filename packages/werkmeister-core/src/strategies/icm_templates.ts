/**
 * ICM stage templates, keyed by work_type. Each stage is a contract the agent
 * reads by itself — the pipeline carries sequencing, not a hook. Generalised
 * from the hand-built ~/features/icm-ws2 after its run-2 fixes: a `decided`
 * status is the approval, reloads use `docker restart` (`docker exec` for idle
 * services), and the test command is quoted from sandbox-context.md rather than
 * restated.
 */

import { COMPOSE_FILE } from "../compose_file.js";

export interface IcmVars {
  /** Path from one stage dir to another stage's dir, by stage name: `../01_research`. */
  at(name: string): string;
  /** The code worktrees, as paths from a stage dir. */
  repos: string;
  /** How to reload running code without `sandbox`. */
  restart: string;
  /** This stage's standards Reference line, or "" — the renderer fills it. */
  standards: string;
  /** The `autonomous` input: every human check renders as a self-check. */
  autonomous: boolean;
}

export interface Contract {
  oneJob: string;
  inputs: string[];
  doNotLoad: string;
  process: string[];
  outputs: string[];
  humanCheck: string;
  /** What replaces `humanCheck` under `autonomous`; default {@link SELF_CHECK}. */
  selfCheck?: string;
}

export interface Stage {
  name: string;
  /** Heading and CONTEXT.md "Job" cell. */
  job: string;
  /** CONTEXT.md "Output" cell. */
  writes: string;
  /** CONTEXT.md "Human check" cell. */
  check: string;
  /** CLAUDE.md route-table "If" cell; default "`<previous dir>` output approved". */
  enter?: string;
  /** Which _shared/standards.md rows the contract names. */
  standards: "none" | "universal" | "all";
  contract(v: IcmVars): Contract;
}

const RELOAD_RULE =
  "Never run `sandbox up`, `sandbox restart`, or `sandbox init-workspace` to reload — " +
  "they are slower, and init rewrites the stage contracts.";

const IMPLEMENT_STEPS = [
  "Confirm ponytail is active (see `_shared/standards.md`; invoke the skill only if it is not), then read the standards rows above. Restate the rule you are applying beside each edit.",
];

const TEST_STEP =
  "Run the test command exactly as `../../.sandbox/sandbox-context.md` states it. Redirect output to a file, trust the exit code, read back only the failing slice.";

export const SELF_CHECK =
  "Review `output/` once against `../../BRIEF.md` and the live issue (`sandbox issue view`). " +
  "Flip every `status: proposed` to `status: decided` yourself, and record each decision — and anything you " +
  "would have asked a person — under `## Recommendations for reviewer` in the PR body. Then start the next stage without asking.";

// Decision 11 (sandbox-133): "ship" means reaching a release, so the stage that
// ends at an approved PR file is "propose".
const EXERCISE_FORMAT =
  "a `| check | result |` table, each result `PASS` or `FAIL`, with the captured output under it";

const propose: Stage = {
  name: "propose",
  job: "acceptance walk and PR files",
  writes: "one commit per code repo touched, `output/pr-<worktree>.md` per repo",
  check: "approve each PR file; `sandbox pr open` opens it",
  standards: "none",
  contract: (v) => ({
    oneJob: `One job: prove each acceptance criterion, commit in each code worktree, and write one PR file per repo touched. ${
      v.autonomous ? "You approve it after the self-check" : "Approving is the person's act"
    }; opening is \`sandbox pr open\`.`,
    inputs: [
      "Working (this run): `../../BRIEF.md` § Acceptance criteria",
      "Working (this run): `../*/output/` — every prior stage's artifacts",
      "Working (this run): `git status` and `git diff --stat` in each repo you touched",
      "Reference (every run): `../../_shared/pr-rules.md` — the PR file format and the gate",
    ],
    doNotLoad: "`_shared/standards.md` (no code is written here), source files, `.sandbox/`.",
    process: [
      "Walk every acceptance criterion in `BRIEF.md`. For each, write PASS or FAIL with the file and line in a prior `output/` that proves it. A FAIL routes back to the owning stage — do not fix it here.",
      "In each code worktree you touched (`git -C <repo>`), commit on its branch with a message that names the change, not the stage. For a repo with `ship: tag` and a `release_check` in the registry, add the release entry it needs (e.g. a changeset) in the same commit.",
      "Write `output/pr-<worktree>.md` per repo touched, in the format of `_shared/pr-rules.md`, at `status: draft`. Title: `<type>(<scope>): <ISSUE-ID> <summary>`. Body: summary, the test and exercise results from prior outputs, the acceptance table from step 1, and `Fixes <issue>` when the tracker is GitHub.",
      "Commit and push this folder's branch — the record. Never open a PR for it.",
    ],
    outputs: [
      "One commit per code repo touched, on that worktree's branch",
      "`output/pr-<worktree>.md` per repo",
    ],
    humanCheck:
      "Read each `pr-*.md`. Set `status: approved` on each one to open — that flip is the approval. Then `sandbox pr open` runs the gate and opens it. Merging is yours. After the release, `sandbox pr status`, then ask the person before `sandbox close-out`. Code written after a PR merged (e.g. found at release) is a follow-up: `sandbox pr new <worktree> --slug <slug>`.",
    selfCheck:
      "Review each `pr-*.md` once against `../../BRIEF.md` and the live issue. Add `## Recommendations for reviewer` to its body — every decision and question collected on the way — then set `status: approved` yourself and run `sandbox pr open`. Stop at the PR URL. Merging is the person's.",
  }),
};

const feature: Stage[] = [
  {
    name: "research",
    job: "inventory the code, surface decisions",
    writes: "`output/inventory.md`, `output/decisions.md`",
    check: "answer every open question in `decisions.md`",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: establish what the code the brief touches does today, and turn the brief's open questions into an editable decision sheet. No code is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} that \`BRIEF.md\` names — grep for call sites, don't read whole trees`,
      ],
      doNotLoad: `\`_shared/standards.md\` (nothing is written here), other stages' contracts, \`.sandbox/*.yml\`, \`${COMPOSE_FILE}\`.`,
      process: [
        "List what exists that the brief touches: entry points, routes or exports, data shapes, and the tests that cover them.",
        "Find the test command in `../../.sandbox/sandbox-context.md` and copy it verbatim — do not restate it from memory.",
        "Check what is already installed that could do the job before recommending anything new.",
        "Write `output/inventory.md`: steps 1–3.",
        "Write `output/decisions.md`: every open question in `BRIEF.md`, each as a heading with `status: proposed`, your recommended answer, and the evidence from steps 1–3. Leave the answer blank when only a person can give it (a ticket key, a preference).",
      ],
      outputs: ["`output/inventory.md`", "`output/decisions.md`"],
      humanCheck:
        "Open `output/decisions.md`. Edit each answer as needed and change its `status: proposed` to `status: decided`. The next stage must not start while any question is still `proposed`. When every question reads `decided`, that is the approval — the next session starts the next stage without asking for confirmation.",
    }),
  },
  {
    name: "spec",
    job: "write the spec for the change",
    writes: "`output/spec.md`, any checkable artifact in the repo",
    check: "the spec covers every acceptance criterion",
    enter:
      "every question in `stages/01_research/output/decisions.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "universal",
    contract: (v) => ({
      oneJob:
        "One job: turn the settled decisions into a spec precise enough that the next stage needs no judgment calls, and prove any machine-checkable part of it.",
      inputs: [
        `Working (this run): \`${v.at("research")}/output/inventory.md\``,
        `Working (this run): \`${v.at("research")}/output/decisions.md\` — every entry must read \`status: decided\`; if not, stop and route back to that stage's human check`,
        "Reference (every run): `../../BRIEF.md` § Acceptance criteria",
      ],
      doNotLoad:
        "source files already summarised in `inventory.md` (if it looks wrong, fix `inventory.md` and tell the person), `.sandbox/*.yml`, other stages.",
      process: [
        "Write `output/spec.md`: what changes, file by file; the interfaces or schemas added; the tests that will prove it; what is explicitly out of scope.",
        "If the change has a machine-checkable artifact (a schema, an API document, a migration), write it in the repo and validate it with a command that needs no new dependency. Record the exact command in `spec.md`.",
        "Map each acceptance criterion in `BRIEF.md` to the step or test in `spec.md` that satisfies it. A criterion with no mapping is a defect in this stage.",
      ],
      outputs: ["`output/spec.md`", "Any artifact from step 2, in the repo"],
      humanCheck:
        "Read `output/spec.md` against the brief. Edit it directly — the next stage builds whatever is on disk.",
    }),
  },
  {
    name: "implement",
    job: "build it and prove it",
    writes: "code diff, `output/exercise.md`",
    check: "read the diff; tests green",
    standards: "all",
    contract: (v) => ({
      oneJob:
        "One job: make the changes `spec.md` lists, add the tests it names, and prove them against the running service.",
      inputs: [
        `Working (this run): \`${v.at("spec")}/output/spec.md\` and the files it names`,
        `Working (this run): \`${v.at("research")}/output/decisions.md\``,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — container names, published ports, test command",
      ],
      doNotLoad: `\`BRIEF.md\` (\`decisions.md\` and \`spec.md\` carry the settled scope), \`inventory.md\`, \`.sandbox/*.yml\`, \`${COMPOSE_FILE}\`, other stages.`,
      process: [
        ...IMPLEMENT_STEPS,
        "Make the changes `spec.md` lists, and only those. No new runtime dependency unless `decisions.md` justified one in a line.",
        "Add the tests `spec.md` names. Match the style of the nearest existing test; no new test framework.",
        TEST_STEP,
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} Then exercise the change as the How-to-validate section of \`sandbox-context.md\` describes for each service touched, and capture the output.`,
        `Write \`output/exercise.md\`: \`git diff --stat\` for each repo you touched, the test exit code and summary line, the exercise checks as ${EXERCISE_FORMAT}, and any deviation from \`spec.md\` with its reason.`,
      ],
      outputs: [
        "Code changes, uncommitted — the next stage commits after the person reads the diff",
        "`output/exercise.md`",
      ],
      humanCheck:
        "Read the diff. Run the tests yourself. Edit the code in place if something is off — the next stage commits what is on disk.",
    }),
  },
  propose,
];

const bugfix: Stage[] = [
  {
    name: "reproduce",
    job: "reproduce and locate the root cause",
    writes: "`output/repro.md`",
    check: "agree the root cause",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: make the failure happen on demand and name its root cause. No fix is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} on the failing path — follow the call chain, don't read whole trees`,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — container names, published ports, logs, test command",
      ],
      doNotLoad:
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.sandbox/*.yml`.",
      process: [
        "Reproduce the failure against the running service or with a test. Record the exact command and its output.",
        "Write the smallest failing test that captures it, in the style of the nearest existing test. Do not commit it yet.",
        "Trace to the root cause: the first place the code does something other than intended. A symptom site is not a root cause.",
        "List every other caller of the function at the root cause — a fix there reaches them too.",
        "Write `output/repro.md`: steps 1–4, and a proposed fix in one paragraph under a `status: proposed` line.",
      ],
      outputs: ["`output/repro.md`", "One failing test, uncommitted"],
      humanCheck:
        "Read `output/repro.md`. Correct the root cause or the proposed fix if needed, then change `status: proposed` to `status: decided`. That is the approval — the next session starts the fix without asking again.",
    }),
  },
  {
    name: "fix",
    job: "fix it at the root cause",
    writes: "code diff, `output/fix.md`",
    check: "read the diff; the failing test now passes",
    enter:
      "`stages/01_reproduce/output/repro.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "all",
    contract: (v) => ({
      oneJob:
        "One job: make the failing test pass by changing the code at the root cause, and nothing else.",
      inputs: [
        `Working (this run): \`${v.at("reproduce")}/output/repro.md\` — must read \`status: decided\`; if not, stop and route back`,
        "Working (this run): the failing test and the files at the root cause",
        "Reference (every run): `../../.sandbox/sandbox-context.md` — test command",
      ],
      doNotLoad:
        "`BRIEF.md` (`repro.md` carries the settled scope), `.sandbox/*.yml`, other stages.",
      process: [
        ...IMPLEMENT_STEPS,
        "Apply the fix `repro.md` settled, at the root cause. Every caller `repro.md` lists gets the fix through the shared function — do not patch callers one by one.",
        TEST_STEP,
        "Write `output/fix.md`: `git diff --stat` per repo, the failing test's name, and the test exit code and summary line.",
      ],
      outputs: ["Code changes plus the test, uncommitted", "`output/fix.md`"],
      humanCheck:
        "Read the diff. Confirm the fix sits where `repro.md` put the root cause. Edit in place if not.",
    }),
  },
  {
    name: "exercise",
    job: "prove it against the running service",
    writes: "`output/exercise.md`",
    check: "the original reproduction no longer fails",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: show the original failure is gone in the running service, not just in the test.",
      inputs: [
        `Working (this run): \`${v.at("reproduce")}/output/repro.md\` — the reproduction steps`,
        `Working (this run): \`${v.at("fix")}/output/fix.md\``,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — container names, published ports",
      ],
      doNotLoad:
        "`_shared/standards.md` (no code is written here), source files, `.sandbox/*.yml`.",
      process: [
        `Reload the running code: ${v.restart}. ${RELOAD_RULE}`,
        "Rerun the reproduction steps from `repro.md` exactly. Capture the output.",
        "Exercise one neighbouring path through each caller `repro.md` listed. Capture the output.",
        `Write \`output/exercise.md\`: steps 2–3 as ${EXERCISE_FORMAT}.`,
      ],
      outputs: ["`output/exercise.md`"],
      humanCheck: "Read `exercise.md`. A FAIL sends the run back to the fix stage.",
    }),
  },
  propose,
];

const refactor: Stage[] = [
  {
    name: "scope",
    job: "fix the boundary and the invariants",
    writes: "`output/scope.md`",
    check: "agree what must not change",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: pin down what the refactor may touch and what behaviour must not change. No code is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} that \`BRIEF.md\` names, and their callers`,
      ],
      doNotLoad:
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.sandbox/*.yml`.",
      process: [
        "List the files in scope and every caller outside it.",
        "State the invariants: observable behaviour that must be identical after the refactor.",
        "Name the existing tests that pin each invariant, and the gaps no test covers.",
        "Write `output/scope.md`: steps 1–3, the sequence of small steps you propose, and a `status: proposed` line.",
      ],
      outputs: ["`output/scope.md`"],
      humanCheck:
        "Read `output/scope.md`. Correct the scope or invariants, then change `status: proposed` to `status: decided`. That is the approval — the next session starts without asking again.",
    }),
  },
  {
    name: "implement",
    job: "refactor in green steps",
    writes: "code diff, `output/exercise.md`",
    check: "read the diff; tests green at every step",
    enter:
      "`stages/01_scope/output/scope.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "all",
    contract: (v) => ({
      oneJob:
        "One job: carry out the steps `scope.md` settled, keeping every invariant true after each one.",
      inputs: [
        `Working (this run): \`${v.at("scope")}/output/scope.md\` — must read \`status: decided\``,
        "Working (this run): the files in scope",
        "Reference (every run): `../../.sandbox/sandbox-context.md` — test command",
      ],
      doNotLoad:
        "`BRIEF.md` (`scope.md` carries the settled scope), `.sandbox/*.yml`, other stages.",
      process: [
        ...IMPLEMENT_STEPS,
        "First add a test for each invariant gap `scope.md` named. They must pass before any code moves.",
        `Take the steps in order. After each one: ${TEST_STEP}`,
        `Reload and exercise the service once at the end: ${v.restart}. ${RELOAD_RULE}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` per repo, the test result after each step, and the final exercise checks as ${EXERCISE_FORMAT}.`,
      ],
      outputs: ["Code changes, uncommitted", "`output/exercise.md`"],
      humanCheck: "Read the diff against `scope.md`. Anything outside scope goes back.",
    }),
  },
  propose,
];

const spike: Stage[] = [
  {
    name: "questions",
    job: "frame what the spike must answer",
    writes: "`output/questions.md`",
    check: "agree the questions and what settles them",
    standards: "none",
    contract: () => ({
      oneJob:
        "One job: turn the brief into questions, each with the evidence that would settle it. No code is written in this stage.",
      inputs: ["Working (this run): `../../BRIEF.md`"],
      doNotLoad: "source trees, `_shared/standards.md`, `.sandbox/*.yml`.",
      process: [
        "List the questions the brief asks or implies, most decision-relevant first.",
        "For each: how it will be answered (read code, measure, prototype) and what result settles it.",
        "Write `output/questions.md`: steps 1–2 and a `status: proposed` line.",
      ],
      outputs: ["`output/questions.md`"],
      humanCheck:
        "Edit the questions, then change `status: proposed` to `status: decided`. That is the approval — the next session starts without asking again.",
    }),
  },
  {
    name: "findings",
    job: "answer them with evidence",
    writes: "`output/findings.md`",
    check: "decide the next piece of work",
    enter:
      "`stages/01_questions/output/questions.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: answer each settled question with evidence, and recommend what to build next.",
      inputs: [
        `Working (this run): \`${v.at("questions")}/output/questions.md\` — must read \`status: decided\``,
        `Working (this run): whatever each question's method names, in ${v.repos}`,
        "Reference (every run): `../../.sandbox/sandbox-context.md` — ports, containers",
        "Reference (when the brief asks for a repo deliverable): `../../_shared/pr-rules.md` — the PR file format and the gate",
      ],
      doNotLoad: "`_shared/standards.md` (prototype code is throwaway), `.sandbox/*.yml`.",
      process: [
        "Answer each question by its method. Prototype code lives in `output/` or on a scratch branch, never on the workspace branch.",
        "Write `output/findings.md`: per question, the answer, the evidence (commands and output), and confidence.",
        "End `findings.md` with a recommendation: the next work item and its work type.",
        "If the brief asks for a deliverable in a code repo (e.g. a doc opened as a PR): commit it on that worktree's branch, and write `output/pr-<worktree>.md` in the format of `_shared/pr-rules.md` at `status: draft`, with an acceptance table and `skip_exercise: <reason>` when there is nothing to exercise.",
      ],
      outputs: [
        "`output/findings.md`",
        "`output/pr-<worktree>.md` per repo — only when the brief asks for a repo deliverable",
      ],
      humanCheck:
        "Read `findings.md`. The recommendation becomes the brief of the next workspace, or the spike ends here. If there is a `pr-*.md`, set `status: approved`; `sandbox pr open` runs the gate and opens it, and close-out waits for it to ship. Otherwise, when the recommendation is recorded where it is needed, `sandbox close-out`.",
    }),
  },
];

export const ICM_TEMPLATES: Record<string, Stage[]> = {
  feature,
  bugfix,
  incident: bugfix,
  refactor,
  spike,
};

/** The stage list for *workType*; free text and unknown types get `feature`. */
export function templateFor(workType: string): Stage[] {
  const wt = workType.trim().toLowerCase();
  return Object.hasOwn(ICM_TEMPLATES, wt) ? ICM_TEMPLATES[wt] : ICM_TEMPLATES["feature"];
}
