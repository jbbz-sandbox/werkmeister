# Workspace Verbs Audit — `workspace` and `init-workspace`

Plan 3 Task 6. These two invented the pattern the whole migration generalises:
a core function taking a resolved answer bag, plus a CLI wizard that collects it.
This checks they meet the §3 contract rather than assuming it.

**Verdict: both clean. No code changes made.**

---

## 1. Logic beyond argv, rendering, exit codes, TTY prompting and cwd resolution?

**`init_workspace.ts` (188 lines) — no.** `withStdoutToStderr`, `readStdinTask`,
`runInteractiveWizard`, `emitSpecError`, `printPrompts`, `printFormSchema`, `run`.
Every one is a wizard driver, a stdin read, or an argv branch. The work is
`provisionWorkspace` / `initWorkspace` in `sandbox-core/workspace_init`, and the
prompt specs are `sandbox-core/workspace_prompts` data.

**`workspace.ts` (187 lines) — no, with one borderline item.** `which(cmd)` is a
PATH lookup, which is neither argv nor rendering. It is 12 lines, has one caller
(`runBrowserForm`), and no consumer outside the CLI wants it. Left where it is —
moving it would be a library function with one caller in a different package.

## 2. Are the seven `process.exit` calls legitimate?

Yes, all of them, in three legitimate shapes:

| Site | Shape |
|---|---|
| `init_workspace.ts:121` (`emitSpecError`) | protocol exit — writes `{"error":…,"prompts":[]}` to stdout for a machine consumer, then exits 1 |
| `init_workspace.ts:181,184` | error-already-printed: `WorkspaceRootError`'s message is pre-rendered and `WorkspaceInitError`'s went out as an `[err]` where it happened, so re-printing via `main.ts`'s handler would duplicate it |
| `workspace.ts:136,141` | precondition validation — the browser form's bundle is missing, or `node` is not on PATH |
| `workspace.ts:155` | exit-code mapping — forwards the spawned form's status |
| `workspace.ts:183` | same error-already-printed shape as init_workspace |

None sits in library code, and none is the "library terminates the process"
pattern the migration exists to remove.

## 3. Is `withStdoutToStderr` still needed?

**Yes — and it is load-bearing, not vestigial.**

The reasoning that might suggest otherwise ("core is silent by default now") is
wrong for this path. `main.ts` wraps every dispatch in
`withReporter(ttyReporter, …)`, and `ttyReporter.emit` writes with `console.log`
— i.e. to **stdout**. `--print-prompts` and `--print-form-schema` emit JSON on
stdout for a machine consumer. Any `info()` raised while building the prompt spec
(`loadConfigFile` raises one) would land in the middle of that JSON and corrupt it.

`withStdoutToStderr` swaps `console.log` for `console.error` around exactly that
window. Removing it would break the Desktop MCP app and the browser dashboard,
and the failure would look like malformed JSON rather than a stray log line.

## 4. `runBrowserForm` — does launching a form belong in this layer?

**Decision: it stays in the CLI. Recorded, not acted on.**

`workspace.ts:129-156` spawns `apps/sandbox-dashboard/dist/form-cli.js` with
inherited stdio and exits with its status. Read plainly, that is argv → spawn →
exit-code mapping, which §7 keeps CLI-side.

The argument for moving it is that a REST/MCP surface might also want to offer a
browser form. But that surface would not want *this*: it would serve the form
itself rather than shell out to a local Node process and inherit a terminal's
stdio. The spawn-and-inherit shape is specifically a terminal affordance.

So this is not deferred work — it is a boundary that happens to fall where the
code already sits. Revisit only if a non-CLI consumer actually asks for it.

---

## Nothing for the close-out to absorb

No contract violation found, so Task 7 inherits nothing from this audit.
