/**
 * ICM stage templates, keyed by work_type. Each stage is a contract the agent
 * reads by itself — the pipeline carries sequencing, not a hook. Generalised
 * from the hand-built ~/features/icm-ws2 after its run-2 fixes: a `decided`
 * status is the approval, reloads use `docker restart` (`docker exec` for idle
 * services), and the test command is quoted from werkmeister-context.md rather than
 * restated.
 */

import { COMPOSE_FILE } from "../compose_file.js";
import { CHAT_APPROVAL } from "../pr_rules.js";

export interface IcmVars {
  /** Path from one stage dir to another stage's dir, by stage name: `../01_research`. */
  at(name: string): string;
  /** The code worktrees, as paths from a stage dir. */
  repos: string;
  /** How to reload running code without `werkmeister`. */
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
  /**
   * The stage's form, which a person answers to approve it. Absent: the renderer adds
   * {@link APPROVAL_FILE}. null: none (propose, whose PR file's `status: approved` is the gate).
   */
  gate?: string | null;
  contract(v: IcmVars): Contract;
}

// SW-309: questions and approvals are Markdown forms the /workspaces pane draws on each workspace's card (md_form.ts).
export const FORM_SYNTAX =
  "Form syntax: each question is a `## ` heading (end it with `(optional)` when no answer is needed), then a `status: proposed` line. " +
  "Options: `- ( )` pick one, `- [ ]` pick any (a single `- [ ]` is a yes/no); tick your pick (`(x)` / `[x]`) and end it with `(recommended)`; an `- ( ) Other:` option takes typed text. " +
  "An empty `**Label:**` line is a text box; `**Label:** text` and other prose (e.g. `**Evidence:** …`) is read-only context.";

export const APPROVAL_FILE = "question-approval.md";

export const approvalForm = (dir: string) =>
  `\`# Approve ${dir}\` / \`## Approve the ${dir} output?\` / \`status: proposed\` / \`- ( ) Approve\` / \`- ( ) Changes needed\` / \`**Changes:**\`, one per line with a blank line between blocks`;

export const QUESTION_RULE = `A question only a person can answer: write \`output/question-<slug>.md\` in the current stage as a form (${FORM_SYNTAX}), with your recommendation ticked and the evidence, then stop. Never ask it only in chat.`;

const ANSWER_IN_PANE = (file: string) =>
  `Answer \`output/${file}\` on its workspace card in the /workspaces pane (Answer), or edit it by hand.`;

const APPROVE_CHOICE =
  "under a `## Approve …?` heading, as a form: `status: proposed` and the choice `- ( ) Approve` / `- ( ) Changes needed`, then an empty `**Changes:**` box";

// SW-135: a container that never started has no `pnpm` in /opt/werkmeister-tools until `werkmeister feature up`
// bootstraps it, so `docker restart` on it loops on "pnpm: not found".
const RELOAD_RULE =
  "If the container is not running, run `werkmeister feature up` once first; `docker restart` only reloads one that is already running. " +
  "Never run `werkmeister feature restart` or `werkmeister workspace init` to reload — " +
  "they are slower, and init rewrites the stage contracts.";

// SW-143: a library or CLI has nothing to restart. How to exercise one is the service's (or its archetype's)
// `validate:` text, so app-specific steps stay out of the generic templates.
const NO_SERVICE_RULE =
  "A library or CLI has no service to restart: build it, then exercise the built artifact exactly as its Validation text in `werkmeister-context.md` § How to validate says.";

const IMPLEMENT_STEPS = [
  "Confirm ponytail is active (see `_shared/standards.md`; invoke the skill only if it is not), then read the standards rows above. Restate the rule you are applying beside each edit.",
];

// SW-124: one wrapper, so no session or subagent hand-rolls (or forgets) its temp HOME.
// SW-316: a host run misses the container's env; the tests-only gate runs where pr open will.
const TEST_STEP =
  "Run the test command exactly as `../../.werkmeister/werkmeister-context.md` states it: through `.werkmeister/bin/with-temp-home`, which gives it a fresh temporary HOME — never hand-roll `HOME=…`. " +
  "That run is on the host, without the container's env (`HOST`, `WERKMEISTER_SLOT`, `NODE_ENV`, `<SVC>_URL`, …), and the PR gate runs the same commands in the workspace container. " +
  "Once it passes, run `werkmeister pr gate --tests` (from the workspace, detached when it may pass 10 minutes) and fix what it fails; record both exit codes. " +
  "A subagent you brief to run tests or the CLI gets that wrapped command verbatim in its brief. " +
  "Redirect output to a file, trust the exit code, read back only the failing slice.";

// SW-106 decision 7 renamed a legacy alias that `git log -S` would have shown was meant to be removed.
const NAME_HISTORY_STEP =
  "For each decision that renames, keeps or removes a name, a fallback or an alias, record its definition site (file and line) and the commit that introduced it (`git log -S <name>`, in the repo that defines it). " +
  'When that commit marks it as a transition or legacy alias, list "remove" as an option beside rename and keep.';

export const SELF_CHECK =
  "Review `output/` once against `../../BRIEF.md` and the live issue (`werkmeister issue view`). " +
  "Flip every `status: proposed` to `status: decided` yourself, and record each decision — and anything you " +
  "would have asked a person — under `## Recommendations for reviewer` in the PR body. Then start the next stage without asking.";

// Decision 11 (sandbox-133): "ship" means reaching a release, so the stage that // name-check: ignore
// ends at an approved PR file is "propose".
// The gate reads every `result` column and rejects any other cell text (SW-247, SW-286).
const exerciseFormat = (col: string) =>
  `a \`| check | result | ${col} |\` table whose result cell is exactly \`PASS\` or \`FAIL\` — nothing else in the cell — with the captured output in the ${col} column. The rule holds for every table in \`exercise.md\`; describe a superseded run in prose, not as a \`FAIL\` row`;

const propose: Stage = {
  name: "propose",
  job: "acceptance walk and PR files",
  writes: "one commit per code repo touched, `output/pr-<worktree>.md` per repo",
  check: "approve each PR file; `werkmeister pr open` opens it",
  standards: "none",
  gate: null,
  contract: (v) => ({
    oneJob: `One job: prove each acceptance criterion, commit in each code worktree, and write one PR file per repo touched. ${
      v.autonomous ? "You approve it after the self-check" : "Approving is the person's act"
    }; opening is \`werkmeister pr open\`.`,
    inputs: [
      "Working (this run): `../../BRIEF.md` § Acceptance criteria",
      "Working (this run): `../*/output/` — every prior stage's artifacts",
      "Working (this run): `git status` and `git diff --stat` in each repo you touched",
      "Reference (every run): `../../_shared/pr-rules.md` — the PR file format and the gate",
    ],
    doNotLoad: "`_shared/standards.md` (no code is written here), source files, `.werkmeister/`.",
    process: [
      "Walk every acceptance criterion in `BRIEF.md`. For each, write a row whose result cell is exactly PASS or FAIL, with the file and line in a prior `output/` that proves it in a separate evidence column. A FAIL routes back to the owning stage — do not fix it here.",
      "In each code worktree you touched (`git -C <repo>`), commit on its branch with a message that names the change, not the stage. For a repo with `ship: tag` and a `release_check` in the registry, add the release entry it needs (e.g. a changeset) in the same commit.",
      "Write `output/pr-<worktree>.md` per repo touched, in the format of `_shared/pr-rules.md`, at `status: draft`, with `repo:` taken from `git -C <worktree> remote get-url origin` (as `owner/repo`; the gate rejects any other value). Title: `<type>(<scope>): <ISSUE-ID> <summary>`. Body: summary, the test and exercise results from prior outputs (every table with a `result` column — the gate reads them all — has a result cell of exactly `PASS` or `FAIL` and the output in its own column), the acceptance table from step 1, and `Fixes <issue>` when the tracker is GitHub.",
      "Commit and push this folder's branch — the record. Never open a PR for it.",
    ],
    outputs: [
      "One commit per code repo touched, on that worktree's branch",
      "`output/pr-<worktree>.md` per repo",
    ],
    humanCheck: `Read each \`pr-*.md\`. Set \`status: approved\` on each one to open — that flip is the approval. Then \`werkmeister pr open\`, run detached as \`_shared/pr-rules.md\` rule 3 shows, runs the gate and opens it. Merging is yours. After the release, \`werkmeister pr status\`, then the post-mortem (\`postmortem\` skill), then ask the person before \`werkmeister workspace close\`. Code written after a PR merged (e.g. found at release) is a follow-up: \`werkmeister pr new <worktree> --slug <slug>\`. ${CHAT_APPROVAL}`,
    selfCheck:
      "Review each `pr-*.md` once against `../../BRIEF.md` and the live issue. Add `## Recommendations for reviewer` to its body — every decision and question collected on the way — then set `status: approved` yourself and run `werkmeister pr open` detached, as `_shared/pr-rules.md` rule 3 shows. Stop at the PR URL. Merging is the person's.",
  }),
};

const feature: Stage[] = [
  {
    name: "research",
    job: "inventory the code, surface decisions",
    writes: "`output/inventory.md`, `output/decisions.md`",
    check: "answer every open question in `decisions.md`",
    standards: "none",
    gate: "decisions.md",
    contract: (v) => ({
      oneJob:
        "One job: establish what the code the brief touches does today, and turn the brief's open questions into an editable decision sheet. No code is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} that \`BRIEF.md\` names — grep for call sites, don't read whole trees`,
      ],
      doNotLoad: `\`_shared/standards.md\` (nothing is written here), other stages' contracts, \`.werkmeister/*.yml\`, \`${COMPOSE_FILE}\`.`,
      process: [
        "List what exists that the brief touches: entry points, routes or exports, data shapes, and the tests that cover them.",
        "Find the test command in `../../.werkmeister/werkmeister-context.md` and copy it verbatim — do not restate it from memory.",
        "Check what is already installed that could do the job before recommending anything new.",
        "Write `output/inventory.md`: steps 1–3.",
        NAME_HISTORY_STEP,
        `Write \`output/decisions.md\` as a form. ${FORM_SYNTAX} Each open question in \`BRIEF.md\` is a \`## \` heading with \`status: proposed\`: a \`- ( )\` choice when one answer fits, \`- [ ]\` when several do, your pick ticked and marked \`(recommended)\`, an \`- ( ) Other:\` option, and the evidence from steps 1–3 and 5 as \`**Evidence:** …\`. When only a person can give the answer (a ticket key, a preference), leave an empty \`**Answer:**\` box instead of options.`,
      ],
      outputs: ["`output/inventory.md`", "`output/decisions.md`"],
      humanCheck: `${ANSWER_IN_PANE("decisions.md")} Edit each answer as needed and change its \`status: proposed\` to \`status: decided\`. The next stage must not start while any question is still \`proposed\`. When every question reads \`decided\`, that is the approval — the next session starts the next stage without asking for confirmation. ${CHAT_APPROVAL}`,
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
        "source files already summarised in `inventory.md` (if it looks wrong, fix `inventory.md` and tell the person), `.werkmeister/*.yml`, other stages.",
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
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — container names, published ports, test command",
      ],
      doNotLoad: `\`BRIEF.md\` (\`decisions.md\` and \`spec.md\` carry the settled scope), \`inventory.md\`, \`.werkmeister/*.yml\`, \`${COMPOSE_FILE}\`, other stages.`,
      process: [
        ...IMPLEMENT_STEPS,
        "Make the changes `spec.md` lists, and only those. No new runtime dependency unless `decisions.md` justified one in a line.",
        "Add the tests `spec.md` names. Match the style of the nearest existing test; no new test framework.",
        TEST_STEP,
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} Then exercise the change as the How-to-validate section of \`werkmeister-context.md\` describes for each service touched, and capture the output. ${NO_SERVICE_RULE}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` for each repo you touched, the host and \`pr gate --tests\` exit codes and summary lines, any deviation from \`spec.md\` with its reason, and the exercise checks as ${exerciseFormat("evidence")}.`,
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
    gate: "repro.md",
    contract: (v) => ({
      oneJob:
        "One job: make the failure happen on demand and name its root cause. No fix is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} on the failing path — follow the call chain, don't read whole trees`,
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — container names, published ports, logs, test command",
      ],
      doNotLoad:
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.werkmeister/*.yml`.",
      process: [
        "Reproduce the failure against the running service or with a test. Record the exact command and its output.",
        "Write the smallest failing test that captures it, in the style of the nearest existing test. Do not commit it yet.",
        "Trace to the root cause: the first place the code does something other than intended. A symptom site is not a root cause.",
        "List every other caller of the function at the root cause — a fix there reaches them too.",
        NAME_HISTORY_STEP,
        `Write \`output/repro.md\`: steps 1–5, and a proposed fix in one paragraph ${APPROVE_CHOICE}.`,
      ],
      outputs: ["`output/repro.md`", "One failing test, uncommitted"],
      humanCheck: `${ANSWER_IN_PANE("repro.md")} Read it, correct the root cause or the proposed fix if needed, then change \`status: proposed\` to \`status: decided\`. That is the approval — the next session starts the fix without asking again. ${CHAT_APPROVAL}`,
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
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — test command",
      ],
      doNotLoad:
        "`BRIEF.md` (`repro.md` carries the settled scope), `.werkmeister/*.yml`, other stages.",
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
    job: "prove it against the running service or the built CLI",
    writes: "`output/exercise.md`",
    check: "the original reproduction no longer fails",
    standards: "none",
    contract: (v) => ({
      oneJob:
        "One job: show the original failure is gone in the running service or the built binary, not just in the test.",
      inputs: [
        `Working (this run): \`${v.at("reproduce")}/output/repro.md\` — the reproduction steps`,
        `Working (this run): \`${v.at("fix")}/output/fix.md\``,
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — container names, published ports",
      ],
      doNotLoad:
        "`_shared/standards.md` (no code is written here), source files, `.werkmeister/*.yml`.",
      process: [
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} ${NO_SERVICE_RULE}`,
        "Rerun the reproduction steps from `repro.md` exactly. Capture the output.",
        "Exercise one neighbouring path through each caller `repro.md` listed. Capture the output.",
        `Write \`output/exercise.md\`: steps 2–3 as ${exerciseFormat("detail")}.`,
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
    gate: "scope.md",
    contract: (v) => ({
      oneJob:
        "One job: pin down what the refactor may touch and what behaviour must not change. No code is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} that \`BRIEF.md\` names, and their callers`,
      ],
      doNotLoad:
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.werkmeister/*.yml`.",
      process: [
        "List the files in scope and every caller outside it.",
        "State the invariants: observable behaviour that must be identical after the refactor.",
        "Name the existing tests that pin each invariant, and the gaps no test covers.",
        `Write \`output/scope.md\`: steps 1–3, and the sequence of small steps you propose ${APPROVE_CHOICE}.`,
      ],
      outputs: ["`output/scope.md`"],
      humanCheck: `${ANSWER_IN_PANE("scope.md")} Read it, correct the scope or invariants, then change \`status: proposed\` to \`status: decided\`. That is the approval — the next session starts without asking again. ${CHAT_APPROVAL}`,
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
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — test command",
      ],
      doNotLoad:
        "`BRIEF.md` (`scope.md` carries the settled scope), `.werkmeister/*.yml`, other stages.",
      process: [
        ...IMPLEMENT_STEPS,
        "First add a test for each invariant gap `scope.md` named. They must pass before any code moves.",
        `Take the steps in order. After each one: ${TEST_STEP}`,
        `Reload and exercise the service once at the end: ${v.restart}. ${RELOAD_RULE} ${NO_SERVICE_RULE}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` per repo, the test result after each step, and the final exercise checks as ${exerciseFormat("evidence")}.`,
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
    gate: "questions.md",
    contract: () => ({
      oneJob:
        "One job: turn the brief into questions, each with the evidence that would settle it. No code is written in this stage.",
      inputs: ["Working (this run): `../../BRIEF.md`"],
      doNotLoad: "source trees, `_shared/standards.md`, `.werkmeister/*.yml`.",
      process: [
        "List the questions the brief asks or implies, most decision-relevant first.",
        "For each: how it will be answered (read code, measure, prototype) and what result settles it.",
        `Write \`output/questions.md\`: steps 1–2, ending ${APPROVE_CHOICE}.`,
      ],
      outputs: ["`output/questions.md`"],
      humanCheck: `${ANSWER_IN_PANE("questions.md")} Edit the questions, then change \`status: proposed\` to \`status: decided\`. That is the approval — the next session starts without asking again. ${CHAT_APPROVAL}`,
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
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — ports, containers",
        "Reference (when the brief asks for a repo deliverable): `../../_shared/pr-rules.md` — the PR file format and the gate",
      ],
      doNotLoad: "`_shared/standards.md` (prototype code is throwaway), `.werkmeister/*.yml`.",
      process: [
        "Answer each question by its method. Prototype code lives in `output/` or on a scratch branch, never on the workspace branch.",
        "Write `output/findings.md`: per question, the answer, the evidence (commands and output), and confidence.",
        "End `findings.md` with a recommendation: the next work item and its work type.",
        "If the brief asks for a deliverable in a code repo (e.g. a doc opened as a PR): commit it on that worktree's branch, and write `output/pr-<worktree>.md` in the format of `_shared/pr-rules.md` at `status: draft`, with `repo:` taken from `git -C <worktree> remote get-url origin` (as `owner/repo`; the gate rejects any other value), an acceptance table and `skip_exercise: <reason>` when there is nothing to exercise.",
      ],
      outputs: [
        "`output/findings.md`",
        "`output/pr-<worktree>.md` per repo — only when the brief asks for a repo deliverable",
      ],
      humanCheck:
        "Read `findings.md`. The recommendation becomes the brief of the next workspace, or the spike ends here. If there is a `pr-*.md`, set `status: approved`; `werkmeister pr open` runs the gate and opens it, and close-out waits for it to ship. Otherwise, when the recommendation is recorded where it is needed, the post-mortem (`postmortem` skill), then `werkmeister workspace close`.",
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
