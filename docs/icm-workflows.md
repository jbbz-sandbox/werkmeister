# ICM workflows and stages

ICM is the [Interpretable Context Methodology](https://github.com/RinDig/Interpretable-Context-Methodology) by Jake Van Clief: the folder structure is the agent's architecture. In Werkmeister it is the `icm` context strategy ([Words](workspace-lifecycle.md#words)).

A workspace is a folder of numbered stages, `stages/NN_<name>/`. Each stage holds `CONTEXT.md`, its contract (one job, inputs, what not to load, process, outputs, human check), and `output/`, where that run's artifacts go. The current stage is the first one whose `output/` holds no file except dotfiles, so a lone `.gitkeep` still counts as empty.

Werkmeister adds three things on top: the gate that `werkmeister pr open` runs, the PR files you approve, and the pane that shows each workspace's current stage.

The stages below come from [`icm_templates.ts`](../packages/werkmeister-core/src/strategies/icm_templates.ts).

## Reading the diagrams

A plain box is a stage and what it writes. A highlighted box marked *you're asked* is a human check: you read the named file and change its `status: proposed` to `status: decided`, or reply in chat. The last one is the PR gate, where you change a PR file's `status: draft` to `status: approved`. The diagrams use the same style as the [Quick Start](quick-start.md) flow.

In an `autonomous` workspace the agent runs each check itself, and you review on the PR ([PR files](workspace-lifecycle.md#pr-files)).

## Picking a work type

`--work-type` takes `feature` (the default), `bugfix`, `incident`, `refactor` or `spike` on `werkmeister workspace new` (and `workspace init`). `incident` gets the bugfix stages. A type found in a repo's or your own `.werkmeister/workflows/` folder uses that workflow (see [Adding your own workflow](#adding-your-own-workflow)). Any other `work_type` gets the feature stages, with a warning.

```sh
werkmeister workspace new my-fix --work-type bugfix
```

## feature

<FlowDiagram label="The feature stages" :steps="[
  { label: '01_research', note: 'inventory.md, decisions.md' },
  { label: 'decisions.md', gate: true },
  { label: '02_spec', note: 'spec.md' },
  { label: 'spec.md', gate: true },
  { label: '03_implement', note: 'diff, exercise.md, review.md' },
  { label: 'review.md', gate: true },
  { label: '04_propose', note: 'commits, PR files' },
  { label: 'PR gate', gate: true },
]" />

| Stage | Writes | You |
|---|---|---|
| `01_research`: inventory the code, surface decisions | `inventory.md`, `decisions.md` | answer every open question in `decisions.md` |
| `02_spec`: write the spec for the change | `spec.md`, any checkable artifact in the repo | the spec covers every acceptance criterion |
| `03_implement`: build it and prove it | code diff, `exercise.md`, `review.md` | read the diff and `review.md`; tests green |
| `04_propose` | see [The propose stage and the gate](#the-propose-stage-and-the-gate) | |

## bugfix and incident

<FlowDiagram label="The bugfix and incident stages" :steps="[
  { label: '01_reproduce', note: 'repro.md, a failing test' },
  { label: 'repro.md', gate: true },
  { label: '02_fix', note: 'diff, fix.md' },
  { label: 'fix.md', gate: true },
  { label: '03_exercise', note: 'exercise.md, review.md' },
  { label: 'review.md', gate: true },
  { label: '04_propose', note: 'commits, PR files' },
  { label: 'PR gate', gate: true },
]" />

| Stage | Writes | You |
|---|---|---|
| `01_reproduce`: reproduce and locate the root cause | `repro.md`, one failing test (uncommitted) | agree the root cause |
| `02_fix`: fix it at the root cause | code diff, `fix.md` | read the diff; the failing test now passes |
| `03_exercise`: prove it against the running service or the built CLI | `exercise.md`, `review.md` | the original reproduction no longer fails |
| `04_propose` | see [The propose stage and the gate](#the-propose-stage-and-the-gate) | |

## refactor

<FlowDiagram label="The refactor stages" :steps="[
  { label: '01_scope', note: 'scope.md' },
  { label: 'scope.md', gate: true },
  { label: '02_implement', note: 'diff, exercise.md, review.md' },
  { label: 'review.md', gate: true },
  { label: '03_propose', note: 'commits, PR files' },
  { label: 'PR gate', gate: true },
]" />

| Stage | Writes | You |
|---|---|---|
| `01_scope`: fix the boundary and the invariants | `scope.md` | agree what must not change |
| `02_implement`: refactor in green steps | code diff, `exercise.md`, `review.md` | read the diff and `review.md`; tests green at every step |
| `03_propose` | see [The propose stage and the gate](#the-propose-stage-and-the-gate) | |

## spike

<FlowDiagram label="The spike stages" :steps="[
  { label: '01_questions', note: 'questions.md' },
  { label: 'questions.md', gate: true },
  { label: '02_findings', note: 'findings.md' },
  { label: 'findings.md', gate: true },
  { label: 'PR gate', note: 'only with a PR file', gate: true },
]" />

| Stage | Writes | You |
|---|---|---|
| `01_questions`: frame what the spike must answer | `questions.md` | agree the questions and what settles them |
| `02_findings`: answer them with evidence | `findings.md` | decide the next piece of work |

A spike has no propose stage. The recommendation in `findings.md` becomes the brief of the next workspace, or the spike ends there. Only when the brief asks for a repo deliverable does findings also write a `pr-<worktree>.md`, and then the gate applies to it ([Spikes](workspace-lifecycle.md#spikes)).

## Adding your own workflow

A team can add its own work type, with its own stages, without changing werkmeister. A workflow is a folder named after the type:

```text
review/
  workflow.yaml        the stage list
  stages/
    triage.md          one contract per stage
    report.md
```

### Where werkmeister looks

For `--work-type review`, init uses the first `review/workflow.yaml` it finds in:

1. each repo in the workspace, at `<repo>/.werkmeister/workflows/review/` (repos in name order)
2. your own folder, `~/.werkmeister/workflows/review/`
3. the built-in of that name, if there is one, else the feature stages

The first one found replaces the rest whole: a folder named `spike` replaces the built-in spike, and stages are never mixed. Init prints where the workflow came from:

```text
[info] work_type "review": workflow from ~/repos/api/.werkmeister/workflows/review.
[info] work_type "spike": workflow from ~/.werkmeister/workflows/spike (replaces the built-in spike).
```

When two repos in one workspace both define the type, init warns that the second is shadowed. The create form lists the types it finds in `~/.werkmeister/workflows/` and in each registered repo's checkout. For a type that exists only on a branch, type it under the wizard's "Other" choice or pass `--work-type`.

### `workflow.yaml`

```yaml
version: 1
stages:
  - name: triage                # lowercase-hyphen; also the file stages/triage.md
    job: sort the findings      # the stage's one-line job
    writes: findings.md         # what its output/ holds
    check: read findings.md     # the human check, in a few words
    grants: [issue view]        # optional, from the allowlist below
  - name: report
    job: write the report
    writes: report.md
    check: approve the report
```

Optional per stage: `enter`, `gate`, `standards` and `grants`. Init renders the stages as `stages/01_triage/`, `stages/02_report/` and so on, in this order.

`grants` pre-approves commands for the whole run, so a workflow may only ask for the ones the built-ins use: `issue start`, `issue view` and `pr push:*`. A workflow in a cloned repo can't pre-approve anything else, such as `feature up` or `pr open`.

### Stage files

Each `stages/<name>.md` uses the sections of a rendered stage `CONTEXT.md`. The text before the first `##` is the stage's one job. Then come `## Inputs`, `## Do NOT load`, `## Process`, `## Outputs` and `## Human check`, plus an optional `## Self-check`. A `##` line inside a code fence is text, not a section. Leave out `## Pre-approved` and the issue-start step: werkmeister adds them.

Three variables are filled in:

| Variable | Becomes |
|---|---|
| <code v-pre>{{repos}}</code> | the workspace's code worktrees |
| <code v-pre>{{restart}}</code> | how to reload the running code |
| <code v-pre>{{at:&lt;stage&gt;}}</code> | the path from this stage to another, e.g. `../01_triage` |

### Errors

Init checks the whole workflow after it makes the worktrees (a repo's workflow lives in one) and before it writes `.env`, `.werkmeister/bin/` or any stage file. A mistake fails init with the folder and the reason, and never falls back to a built-in:

```text
[err]  ICM workflow ~/.werkmeister/workflows/review: stages[0]: grants pr open not allowed (allowed: issue start, issue view, pr push:*)
```

It also fails on a `version` other than 1, an empty `stages:`, a stage without `name`, `job`, `writes` or `check`, a missing `stages/<name>.md`, an unknown or empty section, and an unknown <code v-pre>{{variable}}</code>.

### Create a workflow

1. Run the icm-architect skill on the recurring job. It finds the stages where a person stops to check, and writes one `CONTEXT.md` per stage.
2. Walk-test it once by hand in a scratch folder.

### Turn it into a template

1. Make `<repo>/.werkmeister/workflows/<type>/` for the team, or `~/.werkmeister/workflows/<type>/` for yourself.
2. Copy each stage's `CONTEXT.md` to `stages/<name>.md`, without the `NN_` prefix: the order comes from `workflow.yaml`.
3. Replace paths to other stages with <code v-pre>{{at:&lt;stage&gt;}}</code> and repo paths with <code v-pre>{{repos}}</code>. Delete `## Pre-approved` and the issue-start step.
4. Write `workflow.yaml` as above.
5. Run `werkmeister workspace new <ws> --work-type <type>` and check the `workflow from` line.
6. For the repo level, commit the folder, so everyone who checks the repo out gets it.

To start from a built-in, copy the rendered `stages/*/CONTEXT.md` of any workspace of that type.

### Update a workflow

1. Edit the folder. For the repo level, do it on a branch and merge it like code: a workspace reads the workflow from its own worktree, so it sees the version its branch has.
2. New workspaces get the new version.
3. Existing workspaces keep the version they were built from until you sync them. Init records the folder, its `version` and a hash of `workflow.yaml` and the stage files in `.werkmeister/workflow.lock`. After an edit to the folder, `werkmeister skills check` names it by its absolute path, then lists the contracts that differ:

   ```text
   ✗ template changed since init: /home/me/.werkmeister/workflows/review
   ✗ stages/01_triage/CONTEXT.md
   Workflow template /home/me/.werkmeister/workflows/review changed since init — run `werkmeister skills sync` to re-render its stage contracts.
   ```

   `werkmeister skills sync` re-renders them and updates the lock. A sync with nothing to re-render leaves the lock as it is. A workspace built from a built-in has no lock. If the stage list changed during a run, init and sync leave the stages alone. Move `stages/` aside to regenerate them.

A workflow that stops loading after init (an edit with a mistake) pre-approves nothing until it is fixed, and `skills check` and `sync` fail with its error.

### Try a workflow in a fixture

In a werkmeister workspace, `.werkmeister/bin/with-fixture-workspace` builds a throwaway workspace from a workflow folder under your worktree, with a temporary HOME. `--workflow <dir>` seeds the folder at that HOME's `.werkmeister/workflows/<folder name>/` (`--workflow-in repo` puts it in the fixture's code repo instead), and `--then-append <path> <text>` edits a seeded file between steps:

```sh
with-fixture-workspace --workflow .werkmeister/fixture/workflows/review workspace init --no-build --then skills check
with-fixture-workspace --workflow .werkmeister/fixture/workflows/review workspace init --no-build \
  --then-append workflow:stages/triage.md "edited" --then skills check   # exits 1: template changed since init
```

## The propose stage and the gate

feature, bugfix/incident and refactor end at the same propose stage. It walks every acceptance criterion (PASS, FAIL, or MANUAL for one only a reviewer can check), commits in each code worktree, and writes `output/pr-<worktree>.md` per repo at `status: draft`.

You read each PR file and set `status: approved`: that is the approval. `werkmeister pr open` then runs the gate and, when it passes, pushes the branch and opens the PR. Merging is yours.

The gate's checks (stages, acceptance, clean, the service tests, exercise, review, release and more) are each defined in [The gate](workspace-lifecycle.md#the-gate); the PR file format is in [PR files](workspace-lifecycle.md#pr-files) and the commands are in [Commands](workspace-lifecycle.md#commands).
