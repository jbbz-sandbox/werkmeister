# Design — move the sandbox logic into `sandbox-core`

**Date:** 2026-08-20
**Status:** approved, not started
**Author:** Jay Boyer (decisions), Claude (drafting)

This document is written to be read cold. A session that has never seen the
conversation behind it should be able to execute from here.

---

## 1. The problem

`packages/sandbox-driver` describes itself as a "shared CLI-driving layer": it
shells out to the `sandbox` CLI and exposes typed functions to the
sandbox-dashboard MCP server, Claudeck, and the VS Code extension. The
orchestration logic lives in `apps/cli/src/lib` (12,516 lines) and
`apps/cli/src/commands` (6,038 lines), reachable by other tools only by spawning
a process and parsing its stdout.

The relationship is inverted. The logic should live in a library that the CLI
consumes, so the dashboard, the extension, and any future tool can call it
programmatically instead of scraping a terminal.

**Why this could not be done directly.** The CLI's library layer prints as it
works — roughly 170 calls to `info`/`success`/`warn`/`error` across
`apps/cli/src/lib`, plus 48 `process.exit()` calls in `apps/cli/src/commands`.
`sandbox mcp --stdio` uses **stdout as the MCP JSON-RPC transport**
(`apps/sandbox-dashboard/main.ts`). Importing that code in-process would corrupt
the protocol stream on the first `info()`. The subprocess boundary is what
protects it today. So the migration is gated on replacing printing with an event
contract the caller owns — which is the substance of this design.

### What already shipped

Two merged PRs did the groundwork; do not redo them.

- **#10** — wizard path defaults (`pathDefault()` reads in-progress answers).
- **#11** — `packages/sandbox-driver/config.ts`, exported as
  `sandbox-driver/config`: config/registry path resolution, `workspacesRoot()`,
  `forwardSpecs()`, `slotPortRange()`. Both the CLI and the driver import it. It
  established the precedent this migration follows: **the CLI already depends on
  the driver**, so moving code down is not a new dependency edge.

`.sandbox/notes/015-decision-shared-config-layer-not-cli-inversion.md` records
why #11 stopped where it did. That note's "not done, on purpose" section is what
this design now supersedes. `.sandbox/` is gitignored and local to one machine —
if the note is absent, this document is the record.

---

## 2. Decisions

All five were made by the user on 2026-08-20 and are binding.

| # | Decision | Rationale |
|---|---|---|
| D1 | **All non-interactive commands** move to the library. Not just the orchestration core. | One rule — "the CLI is argv parsing and rendering, the library is everything else" — beats two homes for logic. |
| D2 | **`AsyncLocalStorage`-scoped reporter** for log events. | The MCP server runs concurrent tool calls; a module-level emitter interleaves them with no way to demux, and adding a correlation id means threading it through the same call chain a reporter would have used. ALS is concurrency-correct *and* leaves call sites untouched. |
| D3 | **`dockerode` for the Docker Engine API surface**; `docker compose` stays shelled out. | Structured data instead of text parsing, and real streams for the event contract. Compose is a CLI plugin with no daemon endpoint — see §5. |
| D4 | **The reporter declares passthrough.** | The CLI hands compose its own stdio so build/pull progress renders natively as today; the dashboard pipes and emits `raw` events. One boolean, no regression on the primary human path. |
| D5 | **Rename the package to `sandbox-core`.** | After this it drives no CLI; it *is* the logic. |

---

## 3. The boundary

The test for whether something moves: **does it read a TTY?** Only
`apps/cli/src/lib/wizard.ts` does.

### Stays in `apps/cli`

| Path | Lines | Why |
|---|---|---|
| `src/commands/*` | 6,038 | argv parsing, table rendering, exit-code mapping |
| `src/lib/wizard.ts` | 321 | the `@inquirer/prompts` runner — the only interactive code |
| `src/main.ts` | — | commander wiring; gains the reporter wrap and the error handler |

### Moves to `sandbox-core`

Everything else in `src/lib` — all 37 remaining modules of the 38. The
non-obvious ones:

- **`machine_setup.ts` (1,090)** — moves. Its own docstring says *"NOTHING HERE
  PROMPTS. The wizard in commands/setup.ts collects answers and passes them in."*
  It was already written for this.
- **`global_config.ts` (638)** — moves. `_CONFIG_PROMPTS` and `_INGRESS_PROMPTS`
  are `PromptSpec` **data**, not prompting. The `PromptSpec` type moves with
  them; `wizard.ts` imports it back from the library.
- **`form_schema.ts` (182)** — moves. It renders the RJSF bundle the dashboard
  already consumes via `sandbox workspace --print-form-schema`.
- **`browser.ts` (670)** — moves. It is a Chrome/CDP launcher; its browser-choice
  `PromptSpec` is data.
- **`config.ts` (423)** — moves. Its four print helpers become the reporter (§4);
  its loaders keep the CLI's fail-loud policy, which stays a *caller* concern
  exactly as `sandbox-driver/config` established in #11.

Largest movers, for planning: `generate.ts` (1,474), `machine_setup.ts` (1,090),
`browser.ts` (670), `global_config.ts` (638), `standards.ts` (584),
`claude_md.ts` (569), `web_servers.ts` (489), `caddy.ts` (454).

### Package layout

One package, module per domain. `sandbox.ts` (3,088 lines) stops being a
catch-all; new modules sit beside `config.ts`, `cache.ts`, `jira-rest.ts`:
`reporter.ts`, `proc.ts`, `docker.ts`, `compose.ts`, `slots.ts`, `caddy.ts`,
`generate.ts`, `workspace.ts`, …

Every domain gets a **subpath export** in `package.json`. This is not cosmetic:
it is what lets a consumer avoid pulling `dockerode` into its bundle (§7).

---

## 4. The reporter contract

```ts
// packages/sandbox-core/reporter.ts

export type LogEvent =
  | { level: "info" | "ok" | "warn" | "error"; msg: string }
  | { level: "raw"; chunk: string; stream: "stdout" | "stderr" };

export interface Reporter {
  emit(event: LogEvent): void;
  /** True when the caller owns a TTY and wants child processes to inherit it. */
  passthrough: boolean;
}

/** Run `fn` with `reporter` as the ambient sink for everything it calls. */
export function withReporter<T>(reporter: Reporter, fn: () => Promise<T>): Promise<T>;

/** The four helpers every library module already calls, re-pointed. */
export function info(msg: string): void;
export function success(msg: string): void;
export function warn(msg: string): void;
export function error(msg: string): void;
```

Backed by `AsyncLocalStorage` from `node:async_hooks` (stdlib — no dependency).

**Signatures are unchanged.** `info`/`success`/`warn`/`error` are all
`(msg: string) => void` in `apps/cli/src/lib/config.ts` today. Re-pointing their
*implementation* at the ambient reporter means the ~170 call sites change only
their import path. That property is what makes this migration tractable; do not
give up on it by widening the signatures.

**Default when unset: silent.** Importing the library from a script must neither
crash nor print. A forgotten `withReporter` shows up as missing output, which is
noticeable, rather than as a crash or as protocol corruption.

**Callers:**

```ts
// apps/cli/src/main.ts — one wrap for every command
await withReporter(ttyReporter, () => dispatch(spec.module, args));

// apps/sandbox-dashboard — per tool call, so concurrent calls stay separate
await withReporter({ emit: e => sse.write(e), passthrough: false }, () => up(feature));
```

The direct `console.log` table rendering in `src/commands/status.ts` and friends
is **presentation** and stays in the CLI. The library emits events; it does not
decide how a command's output is laid out.

`colors.ts` is the exception, and moves. 25 messages across 8 library modules
already embed `Colors.` inline for emphasis (`caddy.ts`, `docker.ts`, `k8s.ts`,
`stats.ts`, …). Stripping that would change CLI output, which §11 forbids — so
library messages keep their inline ANSI, and the CLI's reporter adds only the
level prefix colouring (`[info]` cyan, `[err]` red) that `lib/config.ts` applies
today. A consumer that wants plain text strips it; `sandbox-driver` already has
`stripAnsi` and does exactly this.

---

## 5. Errors

The 48 `process.exit(...)` calls in `src/commands` become typed throws from the
library:

```ts
export class SandboxError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
```

`main.ts` gets one top-level handler mapping `code` → process exit status. The
existing `WorkspaceError` in the driver is the same idea and should be folded
into this hierarchy rather than left as a parallel one.

This is not tidiness — it is what makes the sequences callable at all. Today
`up()` terminates the process when a secret is missing
(`apps/cli/src/commands/up.ts`, `checkRequiredSecrets`), which a long-lived MCP
server cannot survive.

---

## 6. What `dockerode` replaces

Every one of these currently shells out and parses text:

| Site | Today | With dockerode |
|---|---|---|
| `lib/docker.ts` `getContainerStatus`, `lib/slots.ts`, driver's `docker ps -a` sweep | `docker ps --format '{{.Label ...}}'` + tab-splitting | `listContainers({ filters })` → objects with `Labels`, `State`, `Status` |
| `lib/stats.ts` | `docker stats --no-stream` + parsing `"1.2GiB / 2GiB"` | `container.stats({ stream: false })` → numbers, no unit parsing |
| `lib/caddy.ts` | `docker cp` + `docker exec caddy caddy adapt` | `putArchive` + `exec` |
| `commands/clean.ts` | `docker volume ls` / `docker volume rm` | volume API |
| `lib/k8s.ts` | `docker inspect` health | `container.inspect()` |

It also fits the reporter better than piping a CLI: `container.logs({ follow: true })`
and the daemon event stream are already streams the library can turn into events.

### What it cannot replace

`dockerode` is an **Engine API** client. Compose v2 is a CLI plugin; the daemon
exposes no compose endpoint. The 10 `docker compose` call sites depend on the
compose graph — `depends_on: service_healthy` gating, profiles, BuildKit builds,
project labels, `.env` interpolation. Reimplementing that is a project, not a
refactor, and `sandbox up` leans on it hardest. `composeUp`/`Down`/`Stop`/
`Restart`/`Logs` stay shelled out, wrapped by the passthrough rule in §7.

### Connection caveat — must be handled

`dockerode` connects via `DOCKER_HOST` or `/var/run/docker.sock`. **It does not
read `docker context`.** On the reference machine the active context is
`orbstack` at `~/.orbstack/run/docker.sock`, and it works only because
`/var/run/docker.sock` happens to symlink there. On a machine whose active
context is not symlinked, the `docker` CLI would be right and `dockerode` would
silently address a different daemon.

**Required:** resolve the endpoint once at library init from
`docker context inspect` (falling back to `DOCKER_HOST`, then the default
socket) and pass it to the `Dockerode` constructor. Cover it with a test.

---

## 7. Compose IO

`lib/docker.ts` currently spawns compose with `stdio: "inherit"`, so build and
pull progress render natively — progress bars, colour, live redraw.

The spawn helper branches on `reporter.passthrough`:

- **`true`** (CLI): hand the child the parent's stdio. Output is byte-identical
  to today.
- **`false`** (dashboard, extension): pipe, and emit each line as
  `{ level: "raw", chunk, stream }`.

Both paths need a test. `apps/cli/src/lib/proc.ts` already takes a `stdio`
option, so this is a branch in the wrapper, not new spawn machinery.

---

## 8. Increments

Bottom-up by dependency. Each row is one PR, independently mergeable, with the
gate green (§10).

| # | PR | Contents | Done when |
|---|---|---|---|
| 0 | Rename | `sandbox-driver` → `sandbox-core`: package name, `main`/`types`/`exports`, and every specifier across `apps/cli`, `apps/sandbox-dashboard`, `apps/claudeck`, `packages/vscode-plugin` (see §11 for the full reference list). Update the false package description. | Gate green; no behavioural diff |
| 1 | Reporter + proc | New `reporter.ts` (ALS, `withReporter`, four helpers). **Moves:** `proc.ts`, `colors.ts`, and the four print helpers lifted out of `config.ts` (the loaders in that file stay until step 3). `main.ts` wraps dispatch. | Every existing CLI output byte-identical; recording-reporter test |
| 2 | Docker layer | New `docker.ts` (dockerode + context resolution) and `compose.ts` (shelled, passthrough wrapper). **Moves:** `docker.ts`. Also *re-points* the Engine-API call sites in `stats.ts`, `caddy.ts`, `k8s.ts`, `slots.ts`, `commands/clean.ts` — those files stay where they are for now and move in their own step. | `sandbox status`, `stats`, `clean`, `proxy-reload` unchanged in behaviour |
| 3 | State layer | **Moves:** `config.ts` (loaders), `global_config.ts`, `slots.ts`, `locks.ts`, `secrets.ts`, `worktrees.ts`, `detect.ts`, `k8s.ts`, `k8s_forwards.ts`, `infra.ts`. | Gate green |
| 4 | Generation | **Moves:** `generate.ts` (1,474), `scaffold.ts`, `caddy.ts`, `feature_routing.ts`, `archetypes.ts`, `claude_md.ts`, `form_schema.ts`. | `generate.test.ts` (29 tests) still passes unmodified |
| 5 | Command sequences | `up`/`down`/`stop`/`restart`/`connect`/`status` become library functions returning typed results; `process.exit` → `SandboxError`; commands go thin. No `lib/` files move. **Decision point for the VS Code bundling risk (§9).** | Dashboard calls `up()` in-process; commands are argv + render only |
| 6 | Remainder | **Moves:** `standards.ts`, `notes.ts`, `gate.ts`, `graduate.ts`, `skill_gen.ts`, `agent_gen.ts`, `hooks_gen.ts`, `mcp_gen.ts`, `workspace_skills.ts`, `machine_setup.ts`, `web_servers.ts`, `telepresence.ts`, `browser.ts`, `safari.ts`, `stats.ts`, `plugin_check.ts`, `git_hooks.ts`. | `apps/cli/src/lib` contains only `wizard.ts` |

Every one of the 38 modules in `apps/cli/src/lib` appears exactly once above or
in "stays" (§3). If a step leaves one behind, the boundary claim in §3 is false —
check before opening the PR.

Steps 2–6 may reorder if a dependency forces it, but 0 and 1 come first: the
rename before any import churn, the reporter before any module that prints
moves.

### Testing

A **recording reporter** — collect `LogEvent[]`, assert the sequence — makes the
command sequences unit-testable for the first time. Today they print and exit,
so they are tested only through their side effects.

For dockerode: test the pure parts (label → status mapping, stats → numbers) and
leave the calls themselves to integration. Do **not** invent a mock layer or an
interface with one real implementation to make it unit-testable.

---

## 9. Risks

**VS Code extension bundling — the one real unknown.**
`packages/vscode-plugin/esbuild.mjs` bundles the driver into a single CJS file
because a `.vsix` cannot resolve a private monorepo workspace at runtime; only
`vscode` is external. After step 5 the extension's `removeWorkspace` call
reaches the docker layer, pulling `dockerode` — and its optional `ssh2` native
bindings — into that bundle. Marking them external is **not** a free fix: an
external dependency has the same unresolvable-at-runtime problem the comment in
that file describes.

Two candidate mitigations, to be chosen at step 5 **by building a `.vsix` and
running it**, not by reasoning:

1. Keep the extension off the docker path — `removeWorkspace` continues to shell
   `sandbox down` via the `resolveSandboxBin` helpers, which stay in the library
   as a supported thin path.
2. Bundle `dockerode` and stub the ssh transport, if and only if `docker-modem`
   turns out to require `ssh2` lazily. Verify; do not assume.

**Other risks**

- The extension defines `import.meta.dirname` → `__dirname` for the driver's
  walk-up path resolution. Preserve that behaviour through the rename.
- `apps/claudeck` streams driver output as raw SSE chunks
  (`plugins/sandbox-workspace/server.js`). When step 5 lands, its consumption of
  `onData` should become `raw` events; until then keep `onData` working.
- Steps 4 and 6 move files with the most tests. Move tests with their modules in
  the same PR; do not leave them importing across the boundary.

---

## 10. Verification

Run for every PR:

```sh
npx turbo run typecheck build test   # 12 tasks; all must pass
./sandbox standards check            # standards tree well-formed
```

Baseline at the time of writing: 247 CLI tests, 113 claudeck test files,
`sandbox-core` node:test suite, 17 vscode-plugin tests.

Smoke both paths — they must agree, since that agreement is the whole point:

```sh
./sandbox status     # forwards table + slot count, rendered by the CLI

# The same facts, read programmatically. The two must agree.
node --input-type=module -e '
  const { getK8sForwardsHealth, listWorkspaces } = await import("sandbox-core");
  const { workspacesRoot } = await import("sandbox-core/config");
  const h = await getK8sForwardsHealth();
  console.log(workspacesRoot(), `${h.healthy}/${h.total}`,
    h.forwards.map(f => `${f.name}:${f.port}`).join(" "));
  console.log((await listWorkspaces()).workspaces.map(w => w.name).join(", "));
'
```

---

## 11. Reference for the implementer

**Repo conventions**

- Invoke the `sb-implement` skill before the first edit. There is no root
  `CLAUDE.md`, so it loads `ponytail` + `sb-comments-standard` +
  `sb-engineering-standard`.
- Record decisions in `.sandbox/notes/NNN-decision-<slug>.md` as they settle.
  Read the existing `decision` notes first; they are binding.
- Conventional commits (`refactor(core): …`). Branch per PR; never commit to
  `main`.
- **The checkout at `/Users/jayboyer/repos/sandbox` is shared by concurrent
  sessions on different branches.** Check `git status` and
  `git branch --show-current` before any branch-state operation.

**Every `sandbox-driver` reference to update in step 0**

- `package.json` deps: `apps/cli`, `apps/sandbox-dashboard`, `apps/claudeck`,
  `packages/vscode-plugin`
- Imports: `apps/cli/src/lib/{global_config,slots,k8s_forwards,wizard}.ts`,
  `apps/cli/src/lib/__tests__/wizard_refine.test.ts`,
  `apps/sandbox-dashboard/{server.ts,form-cli.ts}`,
  `apps/sandbox-dashboard/lib/{localhost-form,session-stream}.ts`,
  `apps/sandbox-dashboard/lib/*.smoke.mjs`,
  `apps/claudeck/plugins/sandbox-workspace/server.js`,
  `packages/vscode-plugin/src/{tree,commands,terminal}.ts`
- Docs: `apps/sandbox-dashboard/README.md`, `apps/claudeck/VENDORED.md`,
  `packages/vscode-plugin/README.md`, `packages/vscode-plugin/esbuild.mjs`
  (comment), plus the prose references in `apps/cli/src/lib/*.ts`

**Deliberately out of scope**

- Reimplementing compose (§6).
- Moving `wizard.ts` or introducing a prompt-provider abstraction. The wizards
  stay CLI-only; the dashboard already has its own web form.
- Any change to what the commands *print*. This migration must be
  output-preserving on the CLI path; a rendering change would make every
  regression invisible.
