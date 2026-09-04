# Design — move the command logic into `sandbox-core`

**Date:** 2026-09-04
**Status:** approved; not yet started
**Author:** Jay Boyer (decisions), Claude (drafting)
**Supersedes:** `2026-08-20-sandbox-core-migration-design.md` (deleted in this
change; recoverable from git history). That document moved `apps/cli/src/lib`
into the library and declared the migration complete. It was complete *for `lib/`*. This
document extends the same boundary to `apps/cli/src/commands`, and replaces the
earlier §3 claim that `src/commands/*` stays in the CLI.

Written to be read cold. A session that has never seen the conversation behind
it should be able to execute from here.

---

## 1. The problem

The predecessor migration moved all 38 modules of `apps/cli/src/lib` into
`packages/sandbox-core`, and turned six verbs — `up`, `down`, `stop`, `restart`,
`connect`, `status` — into callable library functions. It stopped there because
those six were the ones a consumer (the dashboard, claudeck, the VS Code
extension) was actually waiting on. Its §3 listed all 6,038 lines of
`src/commands/*` under "Stays in `apps/cli`".

That boundary was drawn for the consumers that existed. It is wrong for the one
that is coming: **the sandbox verbs should be reachable remotely, which means a
REST or MCP surface alongside the CLI.** A surface can only expose what is
callable, and today ten verbs' orchestration exists only inside a command module
— `services.ts` and `remove.ts` interleave real sequencing with `console.log`,
`intercept.ts` ends its failure path in `process.exit(1)`, and `skills.ts`
imports a helper from *another command module*.

So the rule the predecessor stated — "the CLI is argv parsing and rendering, the
library is everything else" — gets applied to `commands/` as well as `lib/`. The
CLI becomes a consumer of `sandbox-core` rather than its owner.

**This is not a new pattern.** Row 5 of the predecessor already did it for six
verbs, and `up.ts` (82 lines: argv, cwd resolution, one `printSummary`) is the
shape every other command is being moved toward. The work is finishing a
migration, not starting one.

---

## 2. Decisions

Made 2026-09-04 and binding.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Scope is the core migration only.** No REST or MCP surface in this work. | The surface should be designed against real function signatures, not predicted ones. Once core is callable it is a much smaller, separate spec. |
| D2 | **Verb-shaped API.** One exported core function per migrated verb, typed args in, typed result out. | Row 5 already established it. The alternative — leaving composition to each consumer — reproduces the exact problem one layer up: a REST surface would have to re-derive `remove`'s six-step sequence itself. |
| D3 | **`setup` and `config` do not migrate.** | Both are machine-administration wizards that write outside any workspace (`~/.zshenv`, `~/.sandbox/config.yaml`). A remote client cannot fix a broken `~/.zshenv` by calling an API. The line is "mutates the host machine's install", not one named verb. |
| D4 | **`AbortSignal` on the six that spawn or stream**, and nowhere else. | A remote caller has no equivalent of killing the CLI process. Blanket-parameterising every function would add a parameter most have nothing to abort. |
| D5 | **No command manifest.** | Generating `main.ts`'s `SPECS` array and a future surface from one schema is the right end state, but designing it now means designing against zero real callers. The duplication is 25 small entries in one file. Revisit when the surface exists. |

---

## 3. The contract

Every migrated verb is one exported function obeying five rules.

```ts
export interface RemoveArgs { feature: string; service: string }
export interface RemoveResult { removed: string; remaining: string[]; proxyReloaded: boolean }
export async function removeService(a: RemoveArgs): Promise<RemoveResult>;
```

1. **Args are an explicit typed object.** Never `Record<string, unknown>` — the
   CLI's `Namespace` bag stays in `main.ts` — and never resolved from
   `process.cwd()`. The caller resolves; the function receives.
2. **The result is data.** No `Colors`, no `padEnd`, no pre-formatted strings.
   `commands/status.ts` is the model: `statusSnapshot()` returns the facts and
   eight CLI-side printers lay out the table.
3. **Failure throws `SandboxError`** (`packages/sandbox-core/errors.ts`) with a
   `code`. Zero `process.exit` below `main.ts`. Where a hint has to print
   *between* the error line and the exit, the command catches its own code and
   reports — `commands/restart.ts` shows the pattern and it stays legal.
4. **Progress goes through the reporter** — `info`/`success`/`warn`/`error`/`raw`
   from `sandbox-core/reporter`, never `console.*`. See §6 for the exception.
5. **`signal?: AbortSignal`** on exactly `up`, `down`, `test`, `logs`,
   `intercept`, `connect`. A remote caller aborts on client disconnect. The CLI
   derives its signal from SIGINT: `apps/cli/src/lib/interrupt.ts` already owns
   who handles Ctrl-C, so it is where the `AbortController` belongs — but it has
   none today, and adding one is part of this work rather than a thing to reuse.

The reporter contract itself is unchanged and is not re-litigated here: ALS-scoped,
silent when unset, `passthrough` deciding whether a child inherits the parent's
stdio. It shipped in row 1 of the predecessor and every rule above composes with it.

---

## 4. Placement — no new module tree

`lifecycle.ts` already holds `up`/`down`/`stop`/`restart`/`reloadProxy`. That is
the placement rule: **a verb lands in the domain module it orchestrates; a new
module only when nothing fits.**

| Verb | Home | Note |
|---|---|---|
| `remove`, `clean` | `lifecycle.ts` | both are slot → compose → proxy sequences |
| `proxy-reload` | `lifecycle.ts` | `reloadProxy()` exists but lacks the `startCaddy` fallback `commands/proxy_reload.ts` has; extend it |
| `services` | `slots.ts` | |
| `detect` | `detect.ts` | |
| `skills` | `workspace_skills.ts` | `resolveWorkspaceManifest` and `canonical` move here |
| `standards` | `standards.ts` | returns `{ errors: string[] }` instead of exiting |
| `logs` | `compose.ts` | `composeLogs` and `composeLogsStream` are both already there |
| `stats`, `optimize` | `stats.ts` | `parseConfigMem`, `matchService`, the collection loop |
| `intercept` | `telepresence.ts` | the one real build — §5 |
| `notes` context | `notes.ts` | `buildContext`, `renderDecisions`, `renderActiveStandards` |
| `test` | **new** `test_run.ts` | the only new module |

One new file for 23 verbs. If this needed a `verbs/` tree, the domain modules
would be wrong — treat a second new module as a signal to re-read this section
before adding it.

---

## 5. Verb inventory

25 verbs are registered in `main.ts`'s `SPECS`. Two are excluded by D3; the
other 23 fall into three tiers.

### Tier 0 — already the target shape (6)

`up`, `stop`, `restart`, `status`, `connect`, `hooks`.

Row 5 landed these. Work is verification that they obey §3, plus `signal` on
`up` and `connect`. `commands/connect.ts` keeps its three hardcoded
`tools.local.sandbox.com` URLs: moving them opens where tool URLs are
configured, which is not this migration's question.

### Tier 1 — mechanical (10)

`remove`, `proxy-reload`, `clean`, `optimize`, `stats`, `skills`, `services`,
`detect`, `standards`, `logs`.

Every callee is already in core. The work is lifting the sequence, swapping
`process.exit` for `SandboxError`, and leaving the printers behind. No open
questions in any of them. ~1,300 lines of command, of which roughly 400 is
actual logic.

### Tier 2 — needs judgment (7)

- **`intercept`** (180) — the only genuine build, and the only verb with a
  consumer already waiting: claudeck's `POST /intercept` spawns the CLI because
  no core entry point exists (`docs/known-issues.md`, "Claudeck's Streaming
  Routes Still Spawn the CLI"). Three sub-problems: `fail()` becomes a
  `SandboxError` throw — in-process it currently takes the host server down;
  `tp._run` is `spawnSync` and blocks a host's event loop, so it must become
  async before anything long-lived calls it; and the `loadDotenv` walk-up moves
  to the caller.
- **`notes`** (417) — splits along the TTY test. `buildContext`,
  `renderDecisions` and `renderActiveStandards` are pure and migrate.
  `input`, `resolveDomain` and `resolveKind` drive `readline` against a TTY and
  stay. `graduateOne` becomes a core `graduate(domain, kind, note)` plus a CLI
  resolver that feeds it.
- **`down`** (175) — `lifecycle.down` exists, but the command's `printNotes`
  both reads notes and prompts for graduation. Same split: the read is core, the
  prompt is CLI.
- **`test`** (99) — the one new module. `AbortSignal` plus the passthrough
  branch, which the reporter already provides.
- **`open`** (111) — nearly done. `loadWorkspaceYaml`'s walk-up becomes an
  explicit-path core function. The SIGINT handler stays CLI for the reason
  `commands/open.ts` already gives in comment: a library may not install
  process-wide signal handlers on whoever imported it.
- **`workspace`** / **`init-workspace`** (375) — these invented the pattern
  D2 generalises; `provisionWorkspace` and the prompt-spec exports are already
  core. Mostly an audit against §3, plus deciding whether `runBrowserForm`'s
  browser spawn belongs in this layer at all.

### Excluded (2)

`setup` (414) and `config` (152), by D3. Note `machine_setup.ts` (1,090 lines)
is already in core, so `commands/setup.ts` is mostly wizard already — the
exclusion costs almost nothing in coverage.

---

## 6. Three folds

Each was optional debt before D1's rationale and is load-bearing after it.

**1. The reporter conversion.** The predecessor's §8 tracked ten direct
`console.*` writes in core — `compose.ts` ×2, `browser.ts` ×4, `safari.ts` ×4 —
and deferred them to "one dedicated pass". `sandbox mcp --stdio` uses stdout as
the MCP JSON-RPC transport; once core is what a surface calls, these stop being
latent. They convert here.

**The pass is not mechanical.** `packages/sandbox-core/gate.ts:292` is an
eleventh `console.log` the tally of ten missed, and it must stay: it writes the
PreToolUse hook's JSON verdict to stdout, which is a *protocol* write of exactly
the same kind as MCP's transport. A blanket "convert every `console.*` in core"
silently breaks the standards gate. The rule is **protocol writes stay, progress
writes convert**, and all ten named above are progress.

**2. `process.cwd()` resolution moves to the caller.** `intercept`, `open`,
`skills` and `notes` each resolve a feature or workspace by walking up from the
current directory. Every core function takes an explicit feature/workspace and
the CLI does the walk-up. This is consistent with the predecessor's decision to
keep `lib/dotenv.ts` CLI-side, and it is the only way these functions mean
anything to a caller that has no meaningful cwd.

**3. `findWorkspaceRoot` is duplicated.** `apps/cli/src/commands/notes.ts:67`
and `packages/sandbox-core/gate.ts:85` are the same walk-up written twice, and
`commands/skills.ts:22` imports it from the *command module* — the only
command-to-command import edge in the tree, and the one thing here that is
unambiguously wrong today. Delete the CLI copy; point both callers at
`sandbox-core/gate`.

---

## 7. What stays in `apps/cli`

`src/lib/` keeps `wizard.ts` (the only interactive code), `dotenv.ts` (a
`process.cwd()` contract), `interrupt.ts`, the `gate.ts` esbuild entry, and the
`config.ts` re-export door.

`src/commands/*` keeps five things and nothing else:

1. argv mapping (`main.ts`'s `SPECS` → the typed args object)
2. table and banner rendering
3. exit-code mapping, including the catch-own-code hint pattern of §3 rule 3
4. TTY prompting
5. `process.cwd()` resolution

Items 4 and 5 are the ones a remote caller categorically cannot have, which is
why they are the boundary rather than an accident of history. When this lands,
the predecessor's §3 boundary claim is true of `commands/` as well as `lib/`.

---

## 8. Testing

The `collectingReporter` in `packages/sandbox-core/reporter.ts` already makes an
event sequence assertable, and `apps/cli/src/commands/__tests__/down.test.ts` is
the working precedent: it mocks `sandbox-core/lifecycle` and asserts ordering.

Per verb, two tests:

- **Core:** call the function, assert the typed result and the `SandboxError`
  code on the failure path. This is the first time most of these are testable at
  all — today they print and exit.
- **CLI:** mock the core function, assert the rendered output is unchanged.

**Output preservation is the gate.** A rendering change would make every
regression invisible, so the CLI's bytes must not move. For the tier 1 verbs
that means capturing current output before the lift and diffing after.

Run for every PR, as the predecessor did:

```sh
npx turbo run typecheck build test
./sandbox standards check
```

And smoke the two paths against each other — the CLI's rendered `status` and the
same facts read programmatically through core must agree. That agreement is the
whole point of the migration.

---

## 9. Out of scope

- Any REST or MCP surface (D1). This spec makes one possible; it does not build one.
- A command manifest (D5).
- `setup` and `config` (D3).
- Reimplementing `docker compose`. Unchanged from the predecessor: compose v2 is
  a CLI plugin with no daemon endpoint, and `composeUp`/`Down`/`Stop`/`Restart`/
  `Logs` stay shelled out behind the passthrough rule.
- Moving `wizard.ts`, or introducing a prompt-provider abstraction. The wizards
  stay CLI-only; the dashboard has its own web form.
- Any change to what the commands print (§8).

---

## 10. Reference for the implementer

**Repo conventions**

- Invoke the `sb-implement` skill before the first edit. There is no root
  `CLAUDE.md`, so it loads `ponytail` + `sb-comments-standard` +
  `sb-engineering-standard`.
- Record decisions in `.sandbox/notes/NNN-decision-<slug>.md` as they settle, and
  read the existing `decision` notes first — they are binding. `.sandbox/` is
  gitignored and local to one machine; if the notes are absent, this document and
  `docs/known-issues.md` are the record.
- Conventional commits (`refactor(core): …`). Branch per PR; never commit to `main`.
- **The checkout at `/Users/jayboyer/repos/sandbox` is shared by concurrent
  sessions on different branches.** Check `git status` and
  `git branch --show-current` before any branch-state operation.

**Sequencing.** Tier 1 is ten independent lifts with no ordering constraint
between them; tier 2 has one real dependency — `notes`' split must land before
`down`'s, since `commands/down.ts` imports `graduateOne` and `input` from
`commands/notes.ts`. Fold 3 (`findWorkspaceRoot`) is a standalone two-file change
that can go first and unblocks nothing, but removes the one wrong import edge
early. The detailed increments are the implementation plan's job, not this
document's.

**Entries in `docs/known-issues.md` this work closes or changes**

- "Claudeck's Streaming Routes Still Spawn the CLI" — `POST /intercept`'s stated
  blocker is exactly tier 2's `intercept` build. `POST /action`'s stated blocker
  is D4's `AbortSignal`. Both close.
- The predecessor's tracked ten `console.*` writes — fold 1.
