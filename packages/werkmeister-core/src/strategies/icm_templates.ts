/**
 * ICM stage templates, keyed by work_type. Each stage is a contract the agent
 * reads by itself — the pipeline carries sequencing, not a hook. Generalised
 * from the hand-built ~/features/icm-ws2 after its run-2 fixes: a `decided`
 * status is the approval, reloads use `docker restart` (`docker exec` for idle
 * services), and the test command is quoted from werkmeister-context.md rather than
 * restated.
 */

import { COMPOSE_FILE } from "../compose_file.js";
import { APPROVAL_NOTE, CHAT_APPROVAL } from "../pr_rules.js";

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
  /** Member issue keys of a grouped PR (`group` in workspace.yml); empty when it is not one. */
  group: string[];
  /** The harness's question tool (`HarnessLayout.questionTool`); absent → plain text. */
  questionTool?: string;
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
  /** CLAUDE.md route-table "If" cell; default "`<previous dir>` output approved", or its {@link Stage.gate} reading decided. */
  enter?: string;
  /** The `output/` file whose `status: proposed` line the human check flips, when the stage has no other gate. */
  gate?: string;
  /** Which _shared/standards.md rows the contract names. */
  standards: "none" | "all";
  contract(v: IcmVars): Contract;
}

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
const HOST_TESTS =
  "Run the test command exactly as `../../.werkmeister/werkmeister-context.md` states it: through `.werkmeister/bin/with-temp-home`, which gives it a fresh temporary HOME — never hand-roll `HOME=…`. " +
  "That run is on the host, without the container's env (`HOST`, `WERKMEISTER_SLOT`, `NODE_ENV`, `<SVC>_URL`, …), and the PR gate runs the same commands in the workspace container. " +
  // SW-506: werkmeister's host checkout has no node_modules; the recipe is its services.yaml text (SW-190), not this generic step.
  "When a service's How-to-validate text in `werkmeister-context.md` says to run in its container (`docker exec`), follow that text instead: starting this workspace's own container with `werkmeister feature up --service <name>` is expected for it and allowed. ";
const TEST_TAIL =
  "A subagent you brief to run tests or the CLI gets that wrapped command verbatim in its brief. " +
  // SW-125: a host-skipped test still asserted removed behaviour; only the gate's container run found it.
  "A skipped test is not a pass: name each one with its skip reason, and run it where it can run (the workspace container) or say where it will (the gate, CI). " +
  // SW-334: `cmd1 && cmd2 > log` redirects only cmd2; the group sends the whole chain to the log.
  // SW-526: a background job's notice carries the exit code; a trailing echo would make it always read 0.
  'Redirect output to a file as one group, so every command in an `&&` chain lands there. For a background job (`run_in_background`) write background: `{ <test command>; } > <log> 2>&1` and read the exit code from the job\'s completion notice; for a foreground call write foreground: `{ <test command>; } > <log> 2>&1; echo "exit $?"`. Read back only the failing slice.';
const TEST_STEP =
  HOST_TESTS +
  "Once it passes, run `werkmeister pr gate --tests` (from the workspace, detached when it may pass 10 minutes) and fix what it fails; record both exit codes. " +
  TEST_TAIL;
const HOST_TEST_STEP = `${HOST_TESTS}Record its exit code. ${TEST_TAIL}`;
// SW-430: the gate runs once, on reviewed code; a Must fix found after it forced a rerun (SW-344).
const GATE_STEP =
  "Once the review's fixes are in, run `werkmeister pr gate --tests` (from the workspace, detached when it may pass 10 minutes) and fix what it fails; record its exit code. A fix here reruns the host test step first.";

// SW-534: sw-385's exercise on the real harness fixed ~40 lines after the review; they shipped unreviewed.
const REVIEW_DELTA =
  "If the exercise below changes code, rerun the review on that delta: a fresh subagent with the same brief, over the commits and changes made since the first review. Fix its **Must fix** findings, rerun the host test step, and append the result as new rows to `output/review.md`; the gate's review row covers them.";

// SW-351: one of five parallel Edits reported success but never reached the file; tests did not cover it.
const diffCheck = (doc: string) =>
  `Before running tests, read \`git diff\` in each repo you touched and tick off each edit \`${doc}\` settled against it: an edit reported as applied can be missing.`;

const SKIPPED = "every skipped test by name with its skip reason and where it ran instead";

// SW-438: a grouped PR commits per ticket as it goes; the uncommitted-diff contracts contradicted it (sw-323).
const keys = (group: string[]) => group.map((k) => `\`${k}\``).join(", ");
// The merge-base keeps the fold in place; `origin/main` would also move every commit onto an untested base.
const FOLD =
  "`git commit --fixup <sha>`, then `git rebase --autosquash $(git merge-base HEAD origin/main)`";
const groupStep = (v: IcmVars) =>
  v.group.length
    ? [
        `This workspace is a grouped PR (\`group\` in \`workspace.yml\`): one commit per ticket, for the workspace's issue and each member, ${keys(v.group)}, so each can be reverted alone. ` +
          "Take the tickets one at a time: make that ticket's changes and tests, run the diff check below on them, then commit on the worktree's branch with a message that starts with its key (`<KEY> <summary>`) before starting the next. " +
          "Each commit builds and passes the host tests on its own. " +
          // SW-503: a changeset folded into the lead's commit survives a revert of the member that earned it (sw-481).
          "A ticket that changes a released package carries its release entry (changeset) in its own commit. " +
          // SW-466: SW-462's brief said to regenerate the snapshot once for the PR, so three commits failed it alone.
          "When a ticket's change alters a generated snapshot (e.g. `strategy-jit.snapshot.json`), regenerate it in that ticket's commit, so the commit passes the snapshot test alone; a brief that says to regenerate once for the whole PR does not override this. " +
          // SW-497: a scripted reorder to match the spec dropped a commit (sw-406); rebase-and-merge keeps any order.
          "Commit order across tickets is free; a ticket whose change depends on another's evidence (a measurement) can come last. Never reorder commits to match the spec.",
      ]
    : [];

// SW-388: in sw-386 a must-fix passed the tests, the exercise and the gate; only a separate review caught it.
// SW-505: sw-469 wrote review.md as prose and lost a gate pass; the gate reads the `result` column of every table.
const REVIEW_FORMAT =
  "a `| criterion | result | evidence |` table whose result cell is exactly `PASS` or `FAIL` — nothing else in the cell — with the proof in the evidence column";

const reviewStep = (rerun: string, group: string[]) =>
  "Review the diff: for each code worktree you touched, start a fresh subagent and brief it with only the worktree path and " +
  `"run the \`ponytail:ponytail-review\` skill over this worktree's ${
    group.length
      ? "commits in `origin/main...HEAD` (the PR's base in place of `main` when it differs), plus any uncommitted changes and untracked files"
      : "uncommitted changes, untracked files included"
  }" — not how you built it, so the review is not anchored on your reasoning. ` +
  // SW-431: a diff-scoped review missed two trust-boundary holes in a newly pre-approved wrapper (sw-292).
  'If the change adds or widens an allow rule or another pre-approved command, add to the brief: "this change pre-approves a command: list every file, env var, network address or process it can reach from its arguments, and treat each that leaves the workspace or its temp HOME as Must fix". ' +
  // SW-479: an exercise script that could restart the host daemon was rated Should fix and left open (sw-439).
  'Always add: "any finding where the change can restart or write the host daemon, the real `~/.werkmeister` or another workspace, whether through an allow rule, a script or a test, is Must fix". ' +
  // SW-449: a left Should fix shipped a false "every key is checked" in a changeset (sw-412).
  "Fix every **Must fix** finding in place, and any **Should fix** finding that shows the change's own docs, comments, help text or changeset state something false (fix the code, or reword that text so it is true), " +
  `${group.length ? `fold each fix into the commit of the ticket it belongs to (${FOLD}), ` : ""}then ${rerun}. Leave the other **Should fix** and **Nice to have** findings as they are. ` +
  "Write `output/review.md`: per worktree, the findings as the review grouped them, each marked `fixed` or `left: <why>`, then " +
  `${REVIEW_FORMAT}, with one row per worktree (\`PASS\` means no Must fix left open). ` +
  "The PR gate refuses to open a PR while `review.md` is missing or has a row that is not `PASS`; a file of prose alone fails with `has no PASS row`.";
const implementReview = (v: IcmVars) => reviewStep("rerun the host test step above", v.group);

// SW-106 decision 7 renamed a legacy alias that `git log -S` would have shown was meant to be removed.
const NAME_HISTORY_STEP =
  "For each decision that renames, keeps or removes a name, a fallback or an alias, record its definition site (file and line) and the commit that introduced it (`git log -S <name>`, in the repo that defines it). " +
  'When that commit marks it as a transition or legacy alias, list "remove" as an option beside rename and keep.';

// SW-478: a stage gate must be a status line, so /check-in can flip it with its note and the waiting session acts on the file.
const statusGate = (file: string, read: string) =>
  `${read} Then change \`status: proposed\` at the top of \`output/${file}\` to \`status: decided\`: that flip is the approval, and the next session starts without asking again. ${CHAT_APPROVAL}`;
const FIRST_LINE = ", its first line `status: proposed`";

// SW-517: a check left as a sentence at the end of a long reply is easy to miss; the question tool makes it a prompt.
export const askLine = (tool?: string) =>
  tool
    ? `Ask this check through \`${tool}\`: at most 4 questions per call (more than 4: batches of 4, one call after another), each standing on its own (what was checked, 2–3 concrete options with the exact wording or behaviour, the recommended one first; "Other" takes edits). Write each answer into the output file as its status, noted \`${APPROVAL_NOTE.chat}\` (a PR file: \`${APPROVAL_NOTE.chatPr}\`). A check left as a sentence at the end of a reply is not asked.`
    : `Ask this check as one numbered block at the end of your reply: each question stands on its own, options lettered with the recommended one first, then "reply with the letters, or your edits". Write each answer into the output file as its status, noted \`${APPROVAL_NOTE.chat}\` (a PR file: \`${APPROVAL_NOTE.chatPr}\`).`;

export const SELF_CHECK =
  "Review `output/` once against `../../BRIEF.md` and the live issue (`werkmeister issue view`). " +
  "Flip every `status: proposed` to `status: decided` yourself, and record each decision — and anything you " +
  "would have asked a person — under `## Recommendations for reviewer` in the PR body. Then start the next stage without asking.";

// Decision 11 (sandbox-133): "ship" means reaching a release, so the stage that // name-check: ignore
// ends at an approved PR file is "propose".
// The gate reads every `result` column and rejects any other cell text (SW-247, SW-286).
const exerciseFormat = (col: string) =>
  `a \`| check | result | ${col} |\` table whose result cell is exactly \`PASS\` or \`FAIL\` — nothing else in the cell — with the captured output in the ${col} column. The rule holds for every table in \`exercise.md\`; describe a superseded run in prose, not as a \`FAIL\` row`;

const LINT =
  "the repo's lint command (the `&& <lint>` tail of the test command in `werkmeister-context.md`, when it has one, which the PR gate's lint row runs) and fix what it fails, release entry included.";

const propose: Stage = {
  name: "propose",
  job: "acceptance walk and PR files",
  writes:
    "the code commits (one per repo, or one per ticket in a grouped PR), `output/pr-<worktree>.md` per repo",
  check: "approve each PR file; `werkmeister pr open` opens it",
  standards: "none",
  contract: (v) => ({
    oneJob: `One job: prove each acceptance criterion, ${v.group.length ? "check the per-ticket commits in" : "commit in"} each code worktree, and write one PR file per repo touched. ${
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
      "Walk every acceptance criterion in `BRIEF.md`. For each, write a row whose result cell is exactly PASS or FAIL (MANUAL for a criterion only the reviewer can check, e.g. it needs a real PR or the desktop app, with why in the evidence; never PASS for a check nobody ran), with the file and line in a prior `output/` that proves it in a separate evidence column. A FAIL routes back to the owning stage — do not fix it here.",
      v.group.length
        ? // Lint before the fold, so a lint fix lands in a commit and the gate's clean row holds.
          `The commits are already made, one per ticket: keep them, never squash to one per repo. For a repo with \`ship: tag\` and a \`release_check\` in the registry, write the release entry it needs (e.g. a changeset). Run ${LINT} Then fold everything uncommitted into its ticket's commit (${FOLD}), each ticket's release entry into that ticket's own commit, and check that \`git log --oneline origin/main..HEAD\` in each worktree shows one commit per ticket (the workspace's issue and ${keys(v.group)}), each message starting with its key.`
        : "In each code worktree you touched (`git -C <repo>`), commit on its branch with a message that names the change, not the stage. For a repo with `ship: tag` and a `release_check` in the registry, add the release entry it needs (e.g. a changeset) in the same commit. " +
          // SW-399: a changeset written after the last lint run failed the gate only at `pr open`.
          `Before committing, run ${LINT}`,
      // SW-535: sw-385 promised a follow-up in decisions.md; nothing said to file it, so the first `pr open` stopped at the gate.
      "Before the PR file: for each follow-up a decided question in `decisions.md` promises, file it through `../../_shared/issues-report.md` and write its issue key beside that decision. The gate's follow-ups check stays as the backstop.",
      "Write `output/pr-<worktree>.md` per repo touched, in the format of `_shared/pr-rules.md`, at `status: draft`, with `repo:` taken from `git -C <worktree> remote get-url origin` (as `owner/repo`; the gate rejects any other value). Title: `<type>(<scope>): <ISSUE-ID> <summary>`. Body: summary, the test and exercise results from prior outputs (every table with a `result` column — the gate reads them all — has a result cell of exactly `PASS` and the output in its own column: a FAIL cell anywhere in the PR file stops the PR, so describe a pre-fix reproduction in prose, not as a FAIL row), the acceptance table from step 1, and `Fixes <issue>` when the tracker is GitHub." +
        (v.group.length
          ? " Start the body with `Rebase and merge, not squash: one commit per ticket, each revertable alone.` and list each member under the summary."
          : ""),
      "Commit and push this folder's branch — the record. Never open a PR for it.",
    ],
    outputs: [
      v.group.length
        ? "The per-ticket commits, kept, on each worktree's branch"
        : "One commit per code repo touched, on that worktree's branch",
      "`output/pr-<worktree>.md` per repo",
    ],
    humanCheck: `Read each \`pr-*.md\`. Set \`status: approved\` on each one to open — that flip is the approval. Then \`werkmeister pr open\`, run detached as \`_shared/pr-rules.md\` rule 3 shows, runs the gate and opens it. Merging is yours. After the release, \`werkmeister pr status\`, then ${v.group.length ? `check each member reads Done — \`werkmeister issue view <KEY>\` for ${keys(v.group)}; \`pr status\` moves them with the workspace's issue, so move one by hand only if it didn't — then ` : ""}the post-mortem (\`postmortem\` skill), then ask the person before \`werkmeister workspace close\`. Code written after a PR merged (e.g. found at release) is a follow-up: \`werkmeister pr new <worktree> --slug <slug>\`. ${CHAT_APPROVAL}`,
    selfCheck:
      "Review each `pr-*.md` once against `../../BRIEF.md` and the live issue. Add `## Recommendations for reviewer` to its body — every decision and question collected on the way — then set `status: approved` yourself and run `werkmeister pr open` detached, as `_shared/pr-rules.md` rule 3 shows. Stop at the PR URL. Merging is the person's." +
      (v.group.length
        ? ` When the PR ships, check each member reads Done (\`werkmeister issue view <KEY>\` for ${keys(v.group)}) before the post-mortem; \`pr status\` moves them with the workspace's issue, so move one by hand only if it didn't.`
        : ""),
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
      doNotLoad: `\`_shared/standards.md\` (nothing is written here), other stages' contracts, \`.werkmeister/*.yml\`, \`${COMPOSE_FILE}\`.`,
      process: [
        // SW-365: a whole-module mock breaks on every new export of that module (8 failures in sw-341).
        "List what exists that the brief touches: entry points, routes or exports, data shapes, and the tests that cover them. " +
          'For each module the change adds an export to, grep the tests for whole-module mocks of it (e.g. `vi.mock("<module>"`, `mock.module`) and list every hit as a fixture the change must update. ' +
          // SW-242: "no test covers it" was written without a grep; a test pinned the exact old string.
          "For each value the change alters (a string, a default, a command), grep tests and fixtures for that exact value and list the hits; never write that no test covers it without that grep.",
        "Find the test command in `../../.werkmeister/werkmeister-context.md` and copy it verbatim — do not restate it from memory.",
        "Check what is already installed that could do the job before recommending anything new.",
        "Write `output/inventory.md`: steps 1–3.",
        NAME_HISTORY_STEP,
        "Write `output/decisions.md`: every open question in `BRIEF.md`, each as a heading with `status: proposed`, your recommended answer, and the evidence from steps 1–3 and 5. Leave the answer blank when only a person can give it (a ticket key, a preference).",
      ],
      outputs: ["`output/inventory.md`", "`output/decisions.md`"],
      humanCheck: `Open \`output/decisions.md\`. Edit each answer as needed and change its \`status: proposed\` to \`status: decided\`. The next stage must not start while any question is still \`proposed\`. When every question reads \`decided\`, that is the approval — the next session starts the next stage without asking for confirmation. ${CHAT_APPROVAL}`,
    }),
  },
  {
    name: "spec",
    job: "write the spec for the change",
    gate: "spec.md",
    writes: "`output/spec.md`, any checkable artifact in the repo",
    check: "the spec covers every acceptance criterion",
    enter:
      "every question in `stages/01_research/output/decisions.md` reads `status: decided` — the flip *is* the approval, do not ask again",
    // SW-288: every active row, so step 4 can load the ones whose files the spec changes.
    standards: "all",
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
        `Write \`output/spec.md\`: what changes, file by file; the interfaces or schemas added; the tests that will prove it; what is explicitly out of scope.${v.group.length ? " This is a grouped PR: list one commit per ticket (`<KEY> …`) and what each holds, but do not fix their order." : ""}`,
        "If the change has a machine-checkable artifact (a schema, an API document, a migration), write it in the repo and validate it with a command that needs no new dependency. Record the exact command in `spec.md`.",
        "Map each acceptance criterion in `BRIEF.md` to the step or test in `spec.md` that satisfies it. A criterion with no mapping is a defect in this stage.",
        // SW-288: a ticket-vs-standard conflict surfaced only in implement, after the code was written.
        "Load every `_shared/standards.md` row whose Applies-when matches a file `spec.md` changes, not only the universal ones. Under `## Conflicts` in `spec.md`, write one line per place the ticket's proposed shape breaks a loaded standard (the rule, and the shape that would satisfy it), or `none`.",
        // SW-111: SW-104's spec defined a config shape but not how a machine that already had one adds a second.
        "In `spec.md`, answer: how does an existing user turn this on? Name the setup or config path (a setup command, a config key or file) and the doc that describes it, or say none is needed. Map the answer to a criterion as in step 3; a missing answer is a defect in this stage.",
      ],
      outputs: [`\`output/spec.md\`${FIRST_LINE}`, "Any artifact from step 2, in the repo"],
      humanCheck: statusGate(
        "spec.md",
        "Read `output/spec.md` against the brief. Edit it directly — the next stage builds whatever is on disk.",
      ),
    }),
  },
  {
    name: "implement",
    job: "build it and prove it",
    gate: "review.md",
    writes: "code diff, `output/exercise.md`, `output/review.md`",
    check: "read the diff and `review.md`; tests green",
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
        ...groupStep(v),
        "Make the changes `spec.md` lists, and only those. No new runtime dependency unless `decisions.md` justified one in a line.",
        "Add the tests `spec.md` names. Match the style of the nearest existing test; no new test framework.",
        diffCheck("spec.md"),
        HOST_TEST_STEP,
        implementReview(v),
        GATE_STEP,
        REVIEW_DELTA,
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} Then exercise the change as the How-to-validate section of \`werkmeister-context.md\` describes for each service touched, and capture the output. ${NO_SERVICE_RULE}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` for each repo you touched, the host and \`pr gate --tests\` exit codes and summary lines, ${SKIPPED}, any deviation from \`spec.md\` with its reason, and the exercise checks as ${exerciseFormat("evidence")}.`,
      ],
      outputs: [
        v.group.length
          ? "Code changes, one commit per ticket (`<KEY> …`), on the worktree's branch — the next stage keeps them"
          : "Code changes, uncommitted — the next stage commits after the person reads the diff",
        "`output/exercise.md`",
        `\`output/review.md\`: a \`| criterion | result | evidence |\` table, result exactly \`PASS\` or \`FAIL\`${FIRST_LINE}`,
      ],
      humanCheck: statusGate(
        "review.md",
        v.group.length
          ? "Read each ticket's commit (`git log -p origin/main..HEAD` in each worktree) and `review.md`. Run the tests yourself. Edit the code in place if something is off and fold it into that ticket's commit — the next stage keeps the commits as they are."
          : "Read the diff and `review.md`. Run the tests yourself. Edit the code in place if something is off — the next stage commits what is on disk.",
      ),
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
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — container names, published ports, logs, test command",
      ],
      doNotLoad:
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.werkmeister/*.yml`.",
      process: [
        // SW-392: a grep for a line the reporter never prints read "0/25 failures" for a flake nobody reproduced.
        "Reproduce the failure against the running service or with a test. Record the exact command and its output. Judge each run by its exit code, or by a check you have shown fails on a known-bad run — never by grepping the output for a line that may not be printed.",
        "Write the smallest failing test that captures it, in the style of the nearest existing test. Do not commit it yet.",
        "Trace to the root cause: the first place the code does something other than intended. A symptom site is not a root cause.",
        // SW-543: sw-520 grepped one call shape and missed the calls through other helpers; review caught them a round later.
        "List every other caller of the function at the root cause — a fix there reaches them too. When the fix belongs in shared code, list its call sites through every helper or entry point that reaches that code, not one argument shape, and record the search commands (greps) you used in `repro.md`.",
        // SW-442: sessionBusy had two true cases; stage 01 listed callers, so only review caught the second (sw-418).
        "When the proposed fix branches on a predicate, list each condition that makes it true and give each one a test.",
        NAME_HISTORY_STEP,
        "Write `output/repro.md`: steps 1–6, and a proposed fix in one paragraph under a `status: proposed` line.",
      ],
      outputs: ["`output/repro.md`", "One failing test, uncommitted"],
      humanCheck: `Read \`output/repro.md\`. Correct the root cause or the proposed fix if needed, then change \`status: proposed\` to \`status: decided\`. That is the approval — the next session starts the fix without asking again. ${CHAT_APPROVAL}`,
    }),
  },
  {
    name: "fix",
    job: "fix it at the root cause",
    gate: "fix.md",
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
        ...groupStep(v),
        "Apply the fix `repro.md` settled, at the root cause. Every caller `repro.md` lists gets the fix through the shared function — do not patch callers one by one.",
        diffCheck("repro.md"),
        TEST_STEP,
        `Write \`output/fix.md\`: \`git diff --stat\` per repo, the failing test's name, the test exit code and summary line, and ${SKIPPED}.`,
      ],
      outputs: [
        v.group.length
          ? "Code changes plus the test, one commit per ticket"
          : "Code changes plus the test, uncommitted",
        `\`output/fix.md\`${FIRST_LINE}`,
      ],
      humanCheck: statusGate(
        "fix.md",
        `${v.group.length ? "Read each ticket's commit (`git log -p origin/main..HEAD`)" : "Read the diff"}. Confirm the fix sits where \`repro.md\` put the root cause. Edit in place if not.`,
      ),
    }),
  },
  {
    name: "exercise",
    job: "prove it against the running service or the built CLI",
    gate: "review.md",
    writes: "`output/exercise.md`, `output/review.md`",
    check: "the original reproduction no longer fails",
    standards: "all",
    contract: (v) => ({
      oneJob:
        "One job: show the original failure is gone in the running service or the built binary, not just in the test. Then review the diff and fix what must be fixed.",
      inputs: [
        `Working (this run): \`${v.at("reproduce")}/output/repro.md\` — the reproduction steps`,
        `Working (this run): \`${v.at("fix")}/output/fix.md\``,
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — container names, published ports, test command",
      ],
      doNotLoad: "`BRIEF.md` (`repro.md` carries the settled scope), `.werkmeister/*.yml`.",
      process: [
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} ${NO_SERVICE_RULE}`,
        "Rerun the reproduction steps from `repro.md` exactly. Capture the output.",
        "Exercise one neighbouring path through each caller `repro.md` listed. Capture the output.",
        `Write \`output/exercise.md\`: steps 2–3 as ${exerciseFormat("detail")}.`,
        reviewStep(
          "rerun the test command exactly as `../../.werkmeister/werkmeister-context.md` states it (through `.werkmeister/bin/with-temp-home`), rerun steps 2–3 and update `exercise.md`",
          v.group,
        ),
      ],
      outputs: [
        "`output/exercise.md`",
        `\`output/review.md\`: a \`| criterion | result | evidence |\` table, result exactly \`PASS\` or \`FAIL\`${FIRST_LINE}`,
        v.group.length
          ? "Code changes from Must fix findings, folded into their tickets' commits"
          : "Code changes from Must fix findings, uncommitted",
      ],
      humanCheck: statusGate(
        "review.md",
        "Read `exercise.md` and `review.md`. A FAIL sends the run back to the fix stage.",
      ),
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
        "`_shared/standards.md` (nothing is written here), other stages' contracts, `.werkmeister/*.yml`.",
      process: [
        "List the files in scope and every caller outside it.",
        "State the invariants: observable behaviour that must be identical after the refactor.",
        "Name the existing tests that pin each invariant, and the gaps no test covers.",
        // SW-467: the grouped 02_implement takes "its scope.md steps" per ticket, so scope.md nests them that way.
        `Write \`output/scope.md\`: steps 1–3, the sequence of small steps you propose${v.group.length ? ` under one heading per ticket key (the workspace's issue, then ${keys(v.group)})` : ""}, and a \`status: proposed\` line.`,
      ],
      outputs: ["`output/scope.md`"],
      humanCheck: `Read \`output/scope.md\`. Correct the scope or invariants, then change \`status: proposed\` to \`status: decided\`. That is the approval — the next session starts without asking again. ${CHAT_APPROVAL}`,
    }),
  },
  {
    name: "implement",
    job: "refactor in green steps",
    gate: "review.md",
    writes: "code diff, `output/exercise.md`, `output/review.md`",
    check: "read the diff and `review.md`; tests green at every step",
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
        ...groupStep(v),
        "First add a test for each invariant gap `scope.md` named. They must pass before any code moves.",
        // SW-460: groupStep commits per ticket; say how scope.md's steps nest so no step gets its own commit.
        `${v.group.length ? "For each ticket, take its `scope.md` steps in order, then commit it before the next ticket; do not commit after every step. After each step" : "Take the steps in order. After each one"}: ${diffCheck("scope.md")} ${HOST_TEST_STEP}`,
        implementReview(v),
        GATE_STEP,
        REVIEW_DELTA,
        `After the last step, reload and exercise the service: ${v.restart}. ${RELOAD_RULE} ${NO_SERVICE_RULE}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` per repo, the test result after each step, the \`pr gate --tests\` exit code, ${SKIPPED}, and the final exercise checks as ${exerciseFormat("evidence")}.`,
      ],
      outputs: [
        v.group.length
          ? "Code changes, one commit per ticket (`<KEY> …`)"
          : "Code changes, uncommitted",
        "`output/exercise.md`",
        `\`output/review.md\`: a \`| criterion | result | evidence |\` table, result exactly \`PASS\` or \`FAIL\`${FIRST_LINE}`,
      ],
      humanCheck: statusGate(
        "review.md",
        `Read the diff against \`scope.md\`. Anything outside scope goes back.${v.group.length ? " Read it per commit: `git log -p origin/main..HEAD`." : ""}`,
      ),
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
      doNotLoad: "source trees, `_shared/standards.md`, `.werkmeister/*.yml`.",
      process: [
        "List the questions the brief asks or implies, most decision-relevant first.",
        "For each: how it will be answered (read code, measure, prototype) and what result settles it.",
        "Write `output/questions.md`: steps 1–2 and a `status: proposed` line.",
      ],
      outputs: ["`output/questions.md`"],
      humanCheck: `Edit the questions, then change \`status: proposed\` to \`status: decided\`. That is the approval — the next session starts without asking again. ${CHAT_APPROVAL}`,
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

export function stageDirs(stages: Stage[]): string[] {
  return stages.map((s, i) => `${String(i + 1).padStart(2, "0")}_${s.name}`);
}

/** The stage dir that holds PR files, or null for a template with no propose stage (spike). */
export function proposeDir(stages: Stage[]): string | null {
  const i = stages.findIndex((s) => s.name === "propose");
  return i < 0 ? null : stageDirs(stages)[i];
}

/** The stage dir whose output holds PR files: propose, else the last stage (spike, SW-83). */
export function prDir(stages: Stage[]): string {
  return proposeDir(stages) ?? stageDirs(stages)[stages.length - 1];
}
