# ICM workflows and stages

ICM is the [Interpretable Context Methodology](https://github.com/RinDig/Interpretable-Context-Methodology) by Jake Van Clief: the folder structure is the agent's architecture. In Werkmeister it is the `icm` context strategy ([Words](workspace-lifecycle.md#words)).

A workspace is a folder of numbered stages, `stages/NN_<name>/`. Each stage holds `CONTEXT.md`, its contract (one job, inputs, what not to load, process, outputs, human check), and `output/`, where that run's artifacts go. The current stage is the first one whose `output/` holds no file except dotfiles, so a lone `.gitkeep` still counts as empty.

Werkmeister adds three things on top: the gate that `werkmeister pr open` runs, the PR files you approve, and the pane that shows each workspace's current stage.

The stages below come from [`icm_templates.ts`](../packages/werkmeister-core/src/strategies/icm_templates.ts).

## Reading the diagrams

A plain box is a stage and what it writes. A highlighted box marked *you're asked* is a human check: you read the named file and change its `status: proposed` to `status: decided`, or reply in chat. The last one is the PR gate, where you change a PR file's `status: draft` to `status: approved`. The diagrams use the same style as the [Quick Start](quick-start.md) flow.

In an `autonomous` workspace the agent runs each check itself, and you review on the PR ([PR files](workspace-lifecycle.md#pr-files)).

## Picking a work type

`--work-type` takes `feature` (the default), `bugfix`, `incident`, `refactor` or `spike` on `werkmeister workspace new` (and `workspace init`). `incident` gets the bugfix stages. Any other `work_type` written into `workspace.yml` gets the feature stages.

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

## The propose stage and the gate

feature, bugfix/incident and refactor end at the same propose stage. It walks every acceptance criterion (PASS, FAIL, or MANUAL for one only a reviewer can check), commits in each code worktree, and writes `output/pr-<worktree>.md` per repo at `status: draft`.

You read each PR file and set `status: approved`: that is the approval. `werkmeister pr open` then runs the gate and, when it passes, pushes the branch and opens the PR. Merging is yours.

The gate's checks (stages, acceptance, clean, the service tests, exercise, review, release and more) are each defined in [The gate](workspace-lifecycle.md#the-gate); the PR file format is in [PR files](workspace-lifecycle.md#pr-files) and the commands are in [Commands](workspace-lifecycle.md#commands).
