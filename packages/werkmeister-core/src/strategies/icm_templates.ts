/**
 * ICM stage templates, keyed by work_type. Each stage is a contract the agent
 * reads by itself — the pipeline carries sequencing, not a hook. Generalised
 * from the hand-built ~/features/icm-ws2 after its run-2 fixes: a `decided`
 * status is the approval, reloads use `docker restart` (`docker exec` for idle
 * services), and the test command is quoted from werkmeister-context.md rather than
 * restated.
 */

import { COMPOSE_FILE } from "../compose_file.js";
import { generatedFileCheck } from "../generated_file_check.js";
import { APPROVAL_NOTE, CHAT_APPROVAL, HOST_SCRIPT_RULE } from "../pr_rules.js";

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
  /** Which _shared/standards.md rows the contract names; a list names rows, kept only when active. */
  standards: "none" | "all" | string[];
  /** SW-807: `werkmeister` subcommands this stage runs, pre-approved for the whole run; init reads them from here, never from the rendered CONTEXT.md, which the agent can edit. */
  grants?: string[];
  contract(v: IcmVars): Contract;
}

// SW-135: a container that never started has no `pnpm` in /opt/werkmeister-tools until `werkmeister feature up`
// bootstraps it, so `docker restart` on it loops on "pnpm: not found".
const RELOAD_RULE =
  "If the container is not running, run `werkmeister feature up` once first; `docker restart` only reloads one that is already running. " +
  "Never run `werkmeister feature restart` or `werkmeister workspace init` to reload — " +
  "they are slower, and init rewrites the stage contracts.";

// SW-612: sw-588 fell back to a published port after `feature up` warned a routed hostname did not resolve.
const HOSTNAME_RULE =
  "If `werkmeister feature up` warns that a routed hostname does not resolve to 127.0.0.1 (its last warning line points to `werkmeister machine setup`), stop before any browser check and ask the person to run `werkmeister machine setup` (it needs sudo for the hosts entries and certificate trust). Never click through or bypass a certificate warning. Use the container's published port instead only when the person says to skip setup, and record it in `exercise.md` as a deviation.";

// SW-791: sw-772 hand-ran http.server to check a docs page; the Chrome tool refuses file://.
const STATIC_PAGE_RULE =
  "A static HTML page with no service to load it from is served for the browser check, since the Chrome tool refuses `file://`: run `python3 -I -u -m http.server 0 -b 127.0.0.1 -d <dir>` as a background Bash job (never without `-b 127.0.0.1`: it binds every interface by default), open the port its first line prints, and stop the job by its task ID when the check ends. Record it in `exercise.md` as the method.";

// SW-792: Chrome won't size its window below 477 px, so sw-772's 375 px check ran at 477.
const NARROW_VIEWPORT_RULE =
  'The Chrome window does not size below 477 px, so check a narrower width in an iframe on the same origin: open the server\'s root, then with the JS tool replace the body with `<iframe src="<page>" width="375" height="812">`, screenshot it, and check `frame.contentDocument.documentElement.scrollWidth === frame.contentDocument.documentElement.clientWidth`. A page on another origin can\'t be read in the frame: ask the person for that row.';

// SW-143: a library or CLI has nothing to restart. How to exercise one is the service's (or its archetype's)
// `validate:` text, so app-specific steps stay out of the generic templates.
const NO_SERVICE_RULE =
  "A library or CLI has no service to restart: build it, then exercise the built artifact exactly as its Validation text in `werkmeister-context.md` § How to validate says.";

// SW-720: sw-700 had host `node`, a compound line and `docker exec … node <script>` each denied before a probe ran.
const PROBE_RULE =
  "A one-off probe is a `node --test` file run through `.werkmeister/bin/with-temp-home --no-wait node --test <file>`, in the service's container when the host has no node_modules, as `werkmeister-context.md` § How to validate says; never host `node <script>`, a compound shell line or `docker exec … node <script>`.";

// SW-691: sw-681's replay filtered out the very lines that showed its bug, and recorded nothing.
const EXERCISE_WORKAROUND =
  "A filter, workaround or special case the exercise needs before the change passes is a finding: write it into `exercise.md` as a `FAIL` row until the code is fixed, or until the row says why it reflects real use rather than a defect.";

const IMPLEMENT_STEPS = [
  "Confirm ponytail is active (see `_shared/standards.md`; invoke the skill only if it is not), then read the standards rows above. Restate the rule you are applying beside each edit.",
];

// SW-619: sw-597's decision rested on a ticket that merged to main between research and implement; only `issue start` fetched the base.
const baseCheck = (doc: string) =>
  `Before writing code, fetch the base and list \`git log --oneline HEAD..origin/<base> -- <the files \`${doc}\` changes>\` (\`<base>\` is \`main\` unless the workspace's PR base differs; name those files, never the whole tree), and run \`werkmeister issue view <KEY>\` for each ticket a decided question names. ` +
  "If the branch has no commits of its own and the tree is clean, rebase onto the base; with uncommitted changes, never stash (the stash stack is shared) — commit them first or leave the rebase to the person. When a new commit or a ticket change bears on a decided question, stop and ask the person before writing code.";

// SW-124: one wrapper, so no session or subagent hand-rolls (or forgets) its temp HOME.
// SW-316: a host run misses the container's env; the tests-only gate runs where pr open will.
// SW-547: sw-526's over-width test lines surfaced only at the lint chain, after 7 commits.
const HOST_TESTS =
  // SW-646: the command is the repo's `format:` (registry `repo:`), so no toolchain is named here.
  "If `../../.werkmeister/werkmeister-context.md` gives the repo a format command (`Format:` under its repo commands), first run it on the files you touched (never a folder), where the service's tests run (its container when its How-to-validate text says so), so formatting lands in the ticket's own commit. " +
  "Run the test command exactly as `../../.werkmeister/werkmeister-context.md` states it: through `.werkmeister/bin/with-temp-home`, which gives it a fresh temporary HOME — never hand-roll `HOME=…`. " +
  "That run is on the host, without the container's env (`HOST`, `WERKMEISTER_SLOT`, `NODE_ENV`, `<SVC>_URL`, …), and the PR gate runs the same commands in the workspace container. " +
  // SW-506: werkmeister's host checkout has no node_modules; the recipe is its services.yaml text (SW-190), not this generic step.
  "When a service's How-to-validate text in `werkmeister-context.md` says to run in its container (`docker exec`), follow that text instead: starting this workspace's own container with `werkmeister feature up --service <name>` is expected for it and allowed. " +
  // SW-846: sw-829 ran only a one-file fast route in the container; the gate's lint row then failed on formatting.
  "Before `werkmeister pr gate --tests`, run the repo's whole lint chain there too (every command the test command in `werkmeister-context.md` runs ahead of the service's own tests, when it has any; one `&&` segment alone is not it) and fix what it fails: a fast route that runs one test file skips it, and the gate's lint row then fails on it. ";
const TEST_TAIL =
  "A subagent you brief to run tests or the CLI gets that wrapped command verbatim in its brief. " +
  // SW-125: a host-skipped test still asserted removed behaviour; only the gate's container run found it.
  "A skipped test is not a pass: name each one with its skip reason, and run it where it can run (the workspace container) or say where it will (the gate, CI). " +
  // SW-334: `cmd1 && cmd2 > log` redirects only cmd2; the group sends the whole chain to the log.
  // SW-526: a background job's notice carries the exit code; a trailing echo would make it always read 0.
  'Redirect output to a file as one group, so every command in an `&&` chain lands there. For a background job (`run_in_background`) write background: `{ <test command>; } > <log> 2>&1` and read the exit code from the job\'s completion notice; for a foreground call write foreground: `{ <test command>; } > <log> 2>&1; echo "exit $?"`. Read back only the failing slice. ' +
  // SW-764: a stalled background job sends no notice, so waiting on one never ends by itself.
  "For a background test or gate job you wait on, check its log's last-write time: after 10 minutes with no write, stop it and rerun it once, then tell the person if it stalls again.";
const TEST_STEP =
  HOST_TESTS +
  "Once it passes, run `werkmeister pr gate --tests` (from the workspace, as a background job with its log, as rule 3 of `_shared/pr-rules.md` shows) and fix what it fails; record both exit codes. " +
  TEST_TAIL;
const HOST_TEST_STEP = `${HOST_TESTS}Record its exit code. ${TEST_TAIL}`;
// SW-430: the gate runs once, on reviewed code; a Must fix found after it forced a rerun (SW-344).
const GATE_STEP =
  "Once the review's fixes are in, run `werkmeister pr gate --tests` (from the workspace, as a background job with its log, as rule 3 of `_shared/pr-rules.md` shows) and fix what it fails; record its exit code. A fix here reruns the host test step first.";

// SW-534: sw-385's exercise on the real harness fixed ~40 lines after the review; they shipped unreviewed.
// SW-678: a docs fix rerun with one service's tests skipped docs-site's, and the first `pr open` failed on it.
const REVIEW_DELTA =
  "If the exercise below changes code, rerun the review on that delta: a fresh subagent with the same brief, over the commits and changes made since the first review. Fix its **Must fix** findings, rerun `werkmeister pr gate --tests` (not one service's test command: these edits come after the gate above, and the gate retests every service the diff touches), and append the result as new rows to `output/review.md`; the gate's review row covers them.";

// SW-351: one of five parallel Edits reported success but never reached the file; tests did not cover it.
const diffCheck = (doc: string) =>
  `Before running tests, read \`git diff\` in each repo you touched and tick off each edit \`${doc}\` settled against it: an edit reported as applied can be missing.`;

// SW-562: sw-499's two MANUAL rows (a real VS Code window) were approved unrun and shipped as MANUAL, never recorded.
// SW-613: sw-594's browser row listed pages only ("what am I looking for?"); sw-601 saw another workspace's copy with no cookie set.
const MANUAL_STEP =
  "Before asking for approval, list the exercise rows only a person can run (a real VS Code window, a device, a browser). Ask the person for each one's result, one question per row (pass / fail / not run). Each question states the URL to open, how to reach this workspace's copy (the `X-Feature` cookie or selector for a routed hostname, which serves another workspace's copy when none is set, or the container's direct published port, `localhost:<port>`, from `werkmeister-context.md`), and the visible before → after that means PASS; a question that only lists pages to open is not asked. Write the answer into `exercise.md`: PASS or FAIL in the table, and for a row not run a `MANUAL: not run (person's reason)` line under it (the table's result cell stays PASS or FAIL). An approval that skips this keeps those rows MANUAL, and the PR file says why. " +
  HOST_SCRIPT_RULE;

const SKIPPED = "every skipped test by name with its skip reason and where it ran instead";
// SW-126: the stages already ran each service's tests in its container before propose (SW-316, SW-430, SW-506); record them per service.
const PER_SERVICE =
  "the `pr gate --tests` result for each service it tested (one line per service row)";

// SW-438: a grouped PR commits per ticket as it goes; the uncommitted-diff contracts contradicted it (sw-323).
const keys = (group: string[]) => group.map((k) => `\`${k}\``).join(", ");
// The merge-base keeps the fold in place; `origin/main` would also move every commit onto an untested base.
const FOLD =
  "`git commit --fixup <sha>`, then `git rebase --autosquash $(git merge-base HEAD origin/main)`";
// SW-669: the gate's base row fails a branch behind its base; a rebase after the first push needs a force-push the agent can't run.
const REBASE =
  " Then, in each worktree, `git fetch origin <base>`; if `git rev-list --count HEAD..origin/<base>` is not 0, `git rebase origin/<base>` (keeping one commit per ticket) and rerun the tests before the PR file.";
const groupStep = (v: IcmVars) =>
  v.group.length
    ? [
        `This workspace is a grouped PR (\`group\` in \`workspace.yml\`): one commit per ticket, for the workspace's issue and each member, ${keys(v.group)}, so each can be reverted alone. ` +
          "Take the tickets one at a time: make that ticket's changes and tests, run the diff check below on them, then commit on the worktree's branch with a message that starts with its key (`<KEY> <summary>`) before starting the next. " +
          "Each commit builds and passes the host tests on its own. " +
          // SW-904: sw-856 split nine tickets' mixed diff by hunk afterwards; `git apply --cached -U0` misplaced code.
          `Commit each ticket as soon as its change, test and release entry pass, before starting the next; a later fix to an earlier ticket goes in as ${FOLD}. ` +
          "Never split a mixed diff afterwards by hunk (`git apply --cached` with small context, `git add -p`); if a split can't be avoided, stage whole-file versions per commit. " +
          // SW-503: a changeset folded into the lead's commit survives a revert of the member that earned it (sw-481).
          "A ticket that changes a released package carries its release entry in its own commit. " +
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

const reviewStep = (rerun: string, { group, questionTool }: IcmVars) =>
  "Review the diff: for each code worktree you touched, start a fresh subagent and brief it with only the worktree path and " +
  `"run the \`ponytail:ponytail-review\` skill over this worktree's ${
    group.length
      ? "commits in `origin/main...HEAD` (the PR's base in place of `main` when it differs), plus any uncommitted changes and untracked files"
      : "uncommitted changes, untracked files included"
  }" — not how you built it, so the review is not anchored on your reasoning. ` +
  // SW-764: sw-753's background review wrote its transcript once and never reported; the session waited 3.5 h.
  "Run that subagent in the foreground when nothing else is pending. When it runs in the background, check its transcript's last-write time; after 10 minutes with no write, stop it and relaunch it once, and tell the person if the relaunch stalls too. " +
  // SW-431: a diff-scoped review missed two trust-boundary holes in a newly pre-approved wrapper (sw-292).
  'If the change adds or widens an allow rule or another pre-approved command, add to the brief: "this change pre-approves a command: list every file, env var, network address or process it can reach from its arguments, and treat each that leaves the workspace or its temp HOME as Must fix". ' +
  // SW-479: an exercise script that could restart the host daemon was rated Should fix and left open (sw-439).
  'Always add: "any finding where the change can restart or write the host daemon, the real `~/.werkmeister` or another workspace, whether through an allow rule, a script or a test, is Must fix". ' +
  // SW-449: a left Should fix shipped a false "every key is checked" in a changeset (sw-412).
  "Fix every **Must fix** finding in place, and any **Should fix** finding that shows the change's own docs, comments, help text or release entry state something false (fix the code, or reword that text so it is true), " +
  `${group.length ? `fold each fix into the commit of the ticket it belongs to (${FOLD}), ` : ""}then ${rerun}. Leave the other **Should fix** and **Nice to have** findings as they are. ` +
  `${generatedFileCheck(questionTool)} ` +
  "Write `output/review.md`: per worktree, the findings as the review grouped them, each marked `fixed` or `left: <why>`, then " +
  `${REVIEW_FORMAT}, with one row per worktree (\`PASS\` means no Must fix left open). ` +
  "The PR gate refuses to open a PR while `review.md` is missing or has a row that is not `PASS`; a file of prose alone fails with `has no PASS row`.";
const implementReview = (v: IcmVars) => reviewStep("rerun the host test step above", v);

// SW-687: sw-634 decided a blocklist for a pre-approved wrapper's input; one key it let through sent auth to any host.
const PREAPPROVED_INPUT =
  "When the change adds or widens an input to a pre-approved command (an allow rule, or a wrapper an allow rule covers), the decision defaults to an allowlist of accepted values and lists what each accepted value can reach: files, env vars, network addresses, processes. A blocklist needs a stated reason.";

// SW-853: sw-843 probed only the rule it changed; the kept `feature up <own-feature> --service:*` still let `-w <other workspace>` through.
const KEPT_RULE_PROBES =
  "Every rule the fix keeps on the same command gets the same trailing-argument probes as the changed one (another feature or workspace name, `-w`/`--workspace <path>`, extra positional args), and the failing test covers them.";

// SW-901: sw-855's gate passed with 11 Must-fix escapes in allowed commands' own options (`--upl=`, `-lO<cmd>`, `--output`).
const OPTION_REACH =
  "For any change to an allow or deny rule, list each pre-approved command's options that read, write or run anything outside the workspace, in every form the tool accepts (unique-prefix long options, bundled short flags, `--opt=value`). Give each a deny, an exact rule, or a recorded reason it stays open, and check each listed escape as a must-deny case under the real permission matcher (the How-to-validate text in `werkmeister-context.md` names the recipe), not only a model of it.";

// SW-533: the harness-adapter research rule lives in werkmeister-core's validate text, which the research contract never pointed to.
const SERVICE_RESEARCH_RULES =
  "Read the Validation text of each service the change touches in `../../.werkmeister/werkmeister-context.md` § How to validate: a research-stage rule there (for example for a harness-adapter change) applies before any decision reads `decided`.";

// SW-516: sw-484's version-and-command rule for external-tool facts had no check; a run that skipped it passed every gate.
const TOOL_FACT_CHECK =
  "Before the check below flips anything, read `decisions.md` once more: every fact about an external tool's behaviour names the tool's version and, beside it, the command that confirmed it, or is marked `unverified`. A fact with neither fails this check: fix it first.";

// SW-875: sw-578 edited before `feature up`, whose rebuild baked the fix into the dist its fail-first runs used.
// SW-983: the stash stack is shared by every worktree on the machine; a bare pop takes another session's changes.
// SW-990: building first held a 5-CPU container through all the editing; a wave queued at once on entering stage 03.
const BASE_BUILD_RED =
  "A container start can rebuild from the working tree (`werkmeister feature up` reruns the install and build), so see each new test fail against a build of the unfixed code. Write the change and its tests with no container, and start it at the first fail-first run, not at the start of the stage: park the change in a temporary WIP commit (never the shared stash), check out the unfixed source (`git checkout HEAD~ -- <source files>`; `rm` a source file the change adds; the tests stay), run `werkmeister feature up --service <name>` and the new tests, then restore the change (`git checkout HEAD -- <source files>`, then `git reset --soft HEAD~`; `rm` again a file the change deletes) and build and test. Run `werkmeister feature stop` when a long stretch of editing follows. Record which build each fail-first run used.";

// SW-905: sw-856 showed tests red by editing dist/; an incremental tsc didn't re-emit and the edit leaked into the CLI bundle.
const RED_BY_SOURCE =
  "To show a test red, revert the fix in source without losing it (an uncommitted fix: save it with `git diff -- <files> > <scratch>/fix.patch`, revert with `git apply -R`, restore with `git apply`; a committed one: `git show <its commit>~:<file> > <file>`, restore with `git checkout -- <file>`; never the shared stash), rebuild with a forced rebuild that reuses no cache (`--force`), run the test, then restore the source and force-rebuild again. Never edit `dist/` or another build output by hand.";

// SW-914: sw-899's unformatted, untracked reproduce probe failed the fix stage's lint chain and the clean-worktree check.
const PROBE_FORMAT = " Run the repo's `Format:` command (`werkmeister-context.md`) on it.";
const PROBE_HOME =
  "Before the lint chain, fold the reproduce stage's failing test into the ticket's committed test, or move it to `stages/01_reproduce/output/`: an untracked file in the worktree fails the lint chain and the gate's clean-worktree check.";

// SW-898: SW-795's commit made SW-887's flake fix without citing it; SW-887's own PR then conflicted and needed a force-push.
const CITE_OUT_OF_SCOPE =
  "Before fixing a problem outside this run's tickets, find or file its ticket and cite it, as `../../_shared/issues-report.md` § Bugs: new or existing? says.";

// SW-908: sw-903 and sw-890 grepped one package for the old wording and missed restatements in apps/ and docs.
const WHOLE_REPO_GREP =
  " Find them, and any user-facing or generated text that restates the rule being changed (help, docs, man pages, snapshots, expected-text tests), with one `git grep` across the whole repo (`apps/`, `packages/`, tests), not one package, and record the command.";

// SW-885: sw-707 changed sandboxRoot() and listed only template callers; the daemon plist entry it also roots was missed.
const RESOLVER_CALLERS =
  " When the fix changes a shared root or path resolver (a function that picks the tool's root, home or infra folder), list every caller that writes or starts something outside the workspace (a daemon or launchd entry, a proxy config, shared infra, the tool's home folder) and settle how the change reaches each before the fix is decided.";

// SW-960: sw-891 gated on CLAUDECODE; the daemon behind the workspace-pr MCP tool and the pane ran the same gate without it.
const GATE_ROUTES =
  " For a change that gates or refuses a command, every route that runs it is a caller to check: the CLI, daemon or MCP tools, the pane, headless wakes, and other harnesses.";

// SW-931: sw-909's admit reservation file named one clear point; startService never cleared it.
const STATE_CLEAR_POINTS =
  " When the fix adds persisted state (a file, a record field, a marker), list each write and each clear point (every path that ends what the state stands for: success, failure, the other entry points to the same lifecycle) and give each clear point a test.";

// SW-821: sw-807 designed a stage-grant allow list in 02_fix without the reach check; review found 6 Must-fix routes.
const PREAPPROVED_IN_STAGE = `When this stage adds an allow rule or another pre-approved command: ${PREAPPROVED_INPUT} Write that list into this stage's output and into the question that asks the person to approve it.`;

// SW-789: sw-751 named the build chain as the critical path from task start/end times; the row held all 3 CPUs for ~170 s, so only a CPU cut shortens it.
const CPU_PROFILE =
  "When the ticket is about gate, test or build speed, sample the container cgroup `cpu.stat` `usage_usec` every 5 s across a cold run and report the cores in use per phase before naming a critical path or any lever. " +
  "Task start and end times alone do not show whether a path matters. If the run holds all its CPUs, only a CPU cut shortens it, and the decision says so.";

// SW-796: sw-752 decided on one "−40% CPU-s" run under host load 4–7; a paired, alternating A/B under the load wait showed it 30% slower.
const TIMING_CLAIM =
  "A CPU or wall-time number that a decision or acceptance criterion rests on comes from paired, alternating A/B runs (A1 B1 A2 B2 A3 B3, at least 3 each) through `.werkmeister/bin/with-temp-home` with its load wait on, in a Linux container (on macOS the wrapper waits on the Docker VM's load, not the run's own container), never from a single run or `--no-wait`; record every run's numbers and the host load beside them.";

// SW-810: sw-800's spec promised a byte-for-byte skill copy; the docs checks failed it only at the gate.
const COPIED_MARKDOWN =
  "When the change adds or moves markdown into a repo (a copied skill, doc or reference), copy it into the worktree, run the repo's lint command on it (the `<lint> &&` head of its test command in `werkmeister-context.md`, in the service's container, where the repo's docs checks run) and record each failure in `inventory.md`; then remove the copy. `decisions.md` names the edits the text needs, or that the copy passed unchanged.";

// SW-106 decision 7 renamed a legacy alias that `git log -S` would have shown was meant to be removed.
const NAME_HISTORY_STEP =
  "For each decision that renames, keeps or removes a name, a fallback or an alias, record its definition site (file and line) and the commit that introduced it (`git log -S <name>`, in the repo that defines it). " +
  'When that commit marks it as a transition or legacy alias, list "remove" as an option beside rename and keep.';

// SW-478: a stage gate must be a status line, so /check-in can flip it with its note and the waiting session acts on the file.
const statusGate = (file: string, read: string) =>
  `${read} Then change \`status: proposed\` at the top of \`output/${file}\` to \`status: decided\`: that flip is the approval, and the next session starts without asking again. ${CHAT_APPROVAL}`;
const FIRST_LINE = ", its first line `status: proposed`";

// SW-709: sw-614's criterion was checked in the Linux container, where the decided macOS-only row never runs.
const CRITERION_REACH =
  "Before writing a recommended answer or proposed fix, name for each acceptance criterion in `BRIEF.md` how its stated verification runs on that design (which command, which platform or container). A criterion whose verification cannot reach the design is an open question, not a decided one.";

// SW-517: a check left as a sentence at the end of a long reply is easy to miss; the question tool makes it a prompt.
export const askLine = (tool?: string) =>
  tool
    ? `Ask this check through \`${tool}\`: at most 4 questions per call (more than 4: batches of 4, one call after another), each standing on its own (what was checked, 2–3 concrete options with the exact wording or behaviour, the recommended one first; "Other" takes edits). Write each answer into the output file as its status, noted \`${APPROVAL_NOTE.chat}\` (a PR file: \`${APPROVAL_NOTE.chatPr}\`). A check left as a sentence at the end of a reply is not asked.`
    : `Ask this check as one numbered block at the end of your reply: each question stands on its own, options lettered with the recommended one first, then "reply with the letters, or your edits". Write each answer into the output file as its status, noted \`${APPROVAL_NOTE.chat}\` (a PR file: \`${APPROVAL_NOTE.chatPr}\`).`;

export const SELF_CHECK =
  "Review `output/` once against `../../BRIEF.md` and the live issue (`werkmeister issue view`). " +
  "Flip every `status: proposed` to `status: decided` yourself, and record each decision — and anything you " +
  "would have asked a person — under `## Recommendations for reviewer` in the PR body. " +
  // SW-801: the self-flip and the "question only a person can answer" stop point conflicted once a question was put to the person.
  "A question no option settles (none meets the acceptance criteria, or the issue says to ask the person) stays `status: proposed`: ask the person (a stop point) and wait. Never flip a question you have put to the person. " +
  "Then start the next stage without asking.";

// Decision 11 (sandbox-133): "ship" means reaching a release, so the stage that // name-check: ignore
// ends at an approved PR file is "propose".
// The gate reads every `result` column and rejects any other cell text (SW-247, SW-286).
const exerciseFormat = (col: string) =>
  `a \`| check | result | ${col} |\` table whose result cell is exactly \`PASS\` or \`FAIL\` — nothing else in the cell — with the captured output in the ${col} column. The rule holds for every table in \`exercise.md\`; describe a superseded run in prose, not as a \`FAIL\` row`;

// SW-736: `changeset status --since` reads git history, so before the commit it failed on an entry just written (sw-699, sw-755).
// SW-825: the gate stops what it started (SW-34), so sw-798's check hit "container … is not running".
const RELEASE_AFTER_COMMIT =
  "Run the repo's release check (the `Release check:` command in `werkmeister-context.md`) after the commit, not before: a check that compares the branch with its base in git history does not see an uncommitted release entry. When it runs in a service's container, an earlier `werkmeister pr gate --tests` stopped the containers it started: start the one it runs in with `werkmeister feature up --service <name>` first.";

const LINT =
  "the repo's lint command (the `<lint> &&` head of the test command in `werkmeister-context.md`, when it has one, which the PR gate's lint row runs) and fix what it fails, release entry included.";

// SW-793: sw-772 filed ten follow-ups with no epic; grouping them after the PR meant editing 12 tickets again.
const followUpGroup = (tool?: string) =>
  `Before filing 3 or more follow-up tickets, ask the person where they go${tool ? ` (through \`${tool}\`)` : ""}: an existing epic (by name), a new epic (with a proposed title), a label, or none. File each with that parent or label, and record the choice in this stage's output.`;

// SW-807: exact, this workspace's own issue only. The feature, gate and status commands keep asking:
// each can reach shared infra, another workspace or the real ~/.werkmeister from agent-editable input.
const START_GRANTS = ["issue start", "issue view"];

const propose: Stage = {
  name: "propose",
  // SW-717: rule 5's conflict fix pushes its own rebased branch; pr push refuses any other.
  grants: ["pr push:*"],
  job: "acceptance walk and PR files",
  writes:
    "the code commits (one per repo, or one per ticket in a grouped PR), `output/pr-<worktree>.md` per repo",
  check: "approve each PR file; `werkmeister pr open` opens it",
  standards: "none",
  contract: (v) => ({
    // SW-771: the person approves the PR file in every mode; the auto-mode classifier blocks a self-approval.
    oneJob: `One job: prove each acceptance criterion, ${v.group.length ? "check the per-ticket commits in" : "commit in"} each code worktree, and write one PR file per repo touched. Approving is the person's act; opening is \`werkmeister pr open\`.`,
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
          `The commits are already made, one per ticket: keep them, never squash to one per repo. For a repo with \`ship: tag\` and a \`release_check\` in the registry, write the release entry it needs (the \`Release check:\` line in \`werkmeister-context.md\` names its command). Run ${LINT} Then fold everything uncommitted into its ticket's commit (${FOLD}), each ticket's release entry into that ticket's own commit, and check that \`git log --oneline origin/main..HEAD\` in each worktree shows one commit per ticket (the workspace's issue and ${keys(v.group)}), each message starting with its key. ${RELEASE_AFTER_COMMIT}${REBASE}`
        : "In each code worktree you touched (`git -C <repo>`), commit on its branch with a message that names the change, not the stage. For a repo with `ship: tag` and a `release_check` in the registry, add the release entry it needs (the `Release check:` line in `werkmeister-context.md` names its command) in the same commit. " +
          // SW-399: a changeset written after the last lint run failed the gate only at `pr open`.
          `Before committing, run ${LINT} ${RELEASE_AFTER_COMMIT}${REBASE}`,
      // SW-535: sw-385 promised a follow-up in decisions.md; nothing said to file it, so the first `pr open` stopped at the gate.
      "Before the PR file: for each follow-up a decided question in `decisions.md` promises, file it through `../../_shared/issues-report.md` and write its issue key beside that decision. The gate's follow-ups check stays as the backstop. " +
        followUpGroup(v.questionTool),
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
      `Review each \`pr-*.md\` once against \`../../BRIEF.md\` and the live issue. Add \`## Recommendations for reviewer\` to its body — every decision and question collected on the way — then ask the person to approve each PR file. ${askLine(v.questionTool)} On their yes, run \`werkmeister pr open\` detached, as \`_shared/pr-rules.md\` rule 3 shows. Stop at the PR URL. Merging is the person's.` +
      (v.group.length
        ? ` When the PR ships, check each member reads Done (\`werkmeister issue view <KEY>\` for ${keys(v.group)}) before the post-mortem; \`pr status\` moves them with the workspace's issue, so move one by hand only if it didn't.`
        : ""),
  }),
};

// SW-653: a spec planned "commit each batch"; 02_spec cannot see that commits belong to a later stage.
const noCommitPlan = (group: string[]) =>
  group.length
    ? " The implement stage makes those commits; plan the work and its checks, not finer commits."
    : " Code changes stay uncommitted until the propose stage, so plan the work and its checks, not commits.";

const feature: Stage[] = [
  {
    name: "research",
    grants: START_GRANTS,
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
        `Find the test command in \`../../.werkmeister/werkmeister-context.md\` and copy it verbatim — do not restate it from memory. ${SERVICE_RESEARCH_RULES}`,
        "Check what is already installed that could do the job before recommending anything new. " +
          // Moved from docs/harnesses.md: adapter runs kept deciding from a harness's docs, not its binary.
          "When a decision rests on how an external tool behaves (a CLI command or flag, a plugin API, an event name), check it against the installed tool, not only its docs: record `<bin> --version`, and confirm each fact with `<bin> <cmd> --help` or a real run or plugin load. `decisions.md` names the version and, beside each fact, the command that confirmed it; a fact only the docs support is marked `unverified: docs only`, and no decision rests on it. If the tool cannot be installed, say so and mark every such fact `unverified`. " +
          // SW-605: sw-583 recommended a GitHub API call as `unverified` only in the file; the person approved it and a read-only call later returned 403.
          "A recommended answer that rests on an external API, permission or platform behaviour (a token scope, a hosted API's response, a cloud permission) is checked live, read-only (a list, get, `--help` or dry run, never a write), before it goes into `decisions.md`, with the command and its result beside it. When it cannot be checked read-only, write `unverified` in the option text itself, so the question the person is asked carries the word, not only the file. " +
          // SW-765: sw-753's host scratch probe got npm's .gitignore handling and the turbo cache dir wrong for the real repo.
          "A probe of tool behaviour runs in the service's container, with the repo's own layout; starting it with `werkmeister feature up --service <svc>` is allowed for that. A probe in a host scratch project is marked `host scratch` beside the fact, and re-checked in the container before a decision rests on it. " +
          PREAPPROVED_INPUT +
          " " +
          CPU_PROFILE +
          " " +
          TIMING_CLAIM +
          " " +
          COPIED_MARKDOWN,
        "Write `output/inventory.md`: steps 1–3.",
        NAME_HISTORY_STEP,
        `Write \`output/decisions.md\`: every open question in \`BRIEF.md\`, each as a heading with \`status: proposed\`, your recommended answer, and the evidence from steps 1–3 and 5. Leave the answer blank when only a person can give it (a ticket key, a preference). ${CRITERION_REACH} ${TOOL_FACT_CHECK}`,
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
        `Write \`output/spec.md\`: what changes, file by file; the interfaces or schemas added; the tests that will prove it; what is explicitly out of scope. Promise an unchanged (byte-for-byte) copy of markdown only when \`inventory.md\` records the repo's lint passing on it; otherwise list the edits.${v.group.length ? " This is a grouped PR: list one commit per ticket (`<KEY> …`) and what each holds, but do not fix their order." : ""}${noCommitPlan(v.group)}`,
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
        baseCheck("spec.md"),
        ...groupStep(v),
        "Make the changes `spec.md` lists, and only those. No new runtime dependency unless `decisions.md` justified one in a line.",
        PREAPPROVED_IN_STAGE,
        "Add the tests `spec.md` names. Match the style of the nearest existing test; no new test framework.",
        BASE_BUILD_RED,
        diffCheck("spec.md"),
        HOST_TEST_STEP,
        implementReview(v),
        GATE_STEP,
        REVIEW_DELTA,
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} ${HOSTNAME_RULE} ${STATIC_PAGE_RULE} ${NARROW_VIEWPORT_RULE} Then exercise the change as the How-to-validate section of \`werkmeister-context.md\` describes for each service touched, and capture the output. ${NO_SERVICE_RULE} ${PROBE_RULE} ${EXERCISE_WORKAROUND} ${TIMING_CLAIM}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` for each repo you touched, the host and \`pr gate --tests\` exit codes and summary lines, ${PER_SERVICE}, ${SKIPPED}, any deviation from \`spec.md\` with its reason, and the exercise checks as ${exerciseFormat("evidence")}.`,
        MANUAL_STEP,
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
    grants: START_GRANTS,
    job: "reproduce and locate the root cause",
    writes: "`output/repro.md`",
    check: "agree the root cause",
    // SW-837: sw-744's reproduce decided "retry only"; the testing standard already named the fix.
    standards: ["testing", "engineering", "comments"],
    contract: (v) => ({
      oneJob:
        "One job: make the failure happen on demand and name its root cause. No fix is written in this stage.",
      inputs: [
        "Working (this run): `../../BRIEF.md`",
        `Working (this run): the files in ${v.repos} on the failing path — follow the call chain, don't read whole trees`,
        "Reference (every run): `../../.werkmeister/werkmeister-context.md` — container names, published ports, logs, test command",
      ],
      doNotLoad: "other stages' contracts, `.werkmeister/*.yml`.",
      process: [
        // SW-392: a grep for a line the reporter never prints read "0/25 failures" for a flake nobody reproduced.
        `Reproduce the failure against the running service or with a test. Record the exact command and its output. Judge each run by its exit code, or by a check you have shown fails on a known-bad run — never by grepping the output for a line that may not be printed. ${PROBE_RULE}`,
        "Write the smallest failing test that captures it, in the style of the nearest existing test. Do not commit it yet." +
          PROBE_FORMAT,
        "Trace to the root cause: the first place the code does something other than intended. A symptom site is not a root cause.",
        // SW-543: sw-520 grepped one call shape and missed the calls through other helpers; review caught them a round later.
        // SW-566: sw-545's fix changed a return shape its one caller treated as "stop"; only the exercise caught it.
        "List every other caller of the function at the root cause and what each does with the result (an early return, a printed value, a stored state), so the fix's return shape is checked against every caller before the fix stage — a fix there reaches them too. When the fix belongs in shared code, list its call sites through every helper or entry point that reaches that code, not one argument shape, and record the search commands (greps) you used in `repro.md`." +
          WHOLE_REPO_GREP +
          RESOLVER_CALLERS +
          GATE_ROUTES,
        // SW-442: sessionBusy had two true cases; stage 01 listed callers, so only review caught the second (sw-418).
        `When the proposed fix branches on a predicate, list each condition that makes it true and give each one a test. ${PREAPPROVED_INPUT}${STATE_CLEAR_POINTS}`,
        NAME_HISTORY_STEP,
        // SW-564: sw-521's root cause was a permission rule; step 4 listed the callers of one builder and missed two other sources of a matching rule.
        "When the root cause is a permission rule (allow, deny, ask), step 4 lists every source of a matching rule: each builder, each rule derived from a registered command (its `&&` segments included), rules recorded in existing workspaces and how a refresh or migrate removes them, and the list a headless wake passes (`--allowedTools` / `--disallowedTools`). The failing test probes each source. Also `git grep -F` the exact old rule text across the whole repo, tests and `apps/` included, and list each hit as a site the fix must update (SW-820). " +
          KEPT_RULE_PROBES +
          " " +
          OPTION_REACH,
        `Write \`output/repro.md\`: steps 1–7, and a proposed fix in one paragraph under a \`status: proposed\` line.${noCommitPlan(v.group)} Check the proposed fix against the standards rows above and name any rule that already prescribes it. ${CRITERION_REACH}`,
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
        baseCheck("repro.md"),
        ...groupStep(v),
        "Apply the fix `repro.md` settled, at the root cause. Every caller `repro.md` lists gets the fix through the shared function — do not patch callers one by one.",
        CITE_OUT_OF_SCOPE,
        PREAPPROVED_IN_STAGE,
        OPTION_REACH,
        diffCheck("repro.md"),
        RED_BY_SOURCE,
        PROBE_HOME,
        TEST_STEP,
        `Write \`output/fix.md\`: \`git diff --stat\` per repo, the failing test's name, the test exit code and summary line, ${PER_SERVICE}, and ${SKIPPED}.`,
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
        `Reload the running code: ${v.restart}. ${RELOAD_RULE} ${HOSTNAME_RULE} ${STATIC_PAGE_RULE} ${NARROW_VIEWPORT_RULE} ${NO_SERVICE_RULE} ${PROBE_RULE}`,
        "Rerun the reproduction steps from `repro.md` exactly. Capture the output.",
        `Exercise one neighbouring path through each caller \`repro.md\` listed. Capture the output. ${EXERCISE_WORKAROUND} ${TIMING_CLAIM}`,
        `Write \`output/exercise.md\`: steps 2–3 as ${exerciseFormat("detail")}.`,
        // SW-579: the review step rewrites exercise.md, so recorded MANUAL results come first.
        MANUAL_STEP,
        // SW-678: these edits come after the fix stage's gate; one service's test command missed docs-site's (sw-631, sw-669).
        reviewStep(
          "rerun `werkmeister pr gate --tests` (from the workspace, as a background job with its log, as rule 3 of `_shared/pr-rules.md` shows), not one service's test command: it retests every service the diff touches, and these edits come after the fix stage's gate. Then rerun steps 2–3 and update `exercise.md`",
          v,
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
    grants: START_GRANTS,
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
        `Write \`output/scope.md\`: steps 1–3, the sequence of small steps you propose${v.group.length ? ` under one heading per ticket key (the workspace's issue, then ${keys(v.group)})` : ""}, and a \`status: proposed\` line.${noCommitPlan(v.group)}`,
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
        baseCheck("scope.md"),
        ...groupStep(v),
        "First add a test for each invariant gap `scope.md` named. They must pass before any code moves.",
        PREAPPROVED_IN_STAGE,
        // SW-460: groupStep commits per ticket; say how scope.md's steps nest so no step gets its own commit.
        `${v.group.length ? "For each ticket, take its `scope.md` steps in order, then commit it before the next ticket; do not commit after every step. After each step" : "Take the steps in order. After each one"}: ${diffCheck("scope.md")} ${HOST_TEST_STEP}`,
        implementReview(v),
        GATE_STEP,
        REVIEW_DELTA,
        `After the last step, reload and exercise the service: ${v.restart}. ${RELOAD_RULE} ${HOSTNAME_RULE} ${STATIC_PAGE_RULE} ${NARROW_VIEWPORT_RULE} ${NO_SERVICE_RULE} ${PROBE_RULE} ${EXERCISE_WORKAROUND} ${TIMING_CLAIM}`,
        `Write \`output/exercise.md\`: \`git diff --stat\` per repo, the test result after each step, the \`pr gate --tests\` exit code, ${PER_SERVICE}, ${SKIPPED}, and the final exercise checks as ${exerciseFormat("evidence")}.`,
        MANUAL_STEP,
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
    grants: START_GRANTS,
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
        `End \`findings.md\` with a recommendation: the next work item and its work type. ${followUpGroup(v.questionTool)}`,
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

/** Every stage's grants for *workType*, once each: granted for the whole run (SW-807). */
export function stageGrants(workType: string): string[] {
  return [...new Set(templateFor(workType).flatMap((s) => s.grants ?? []))];
}
