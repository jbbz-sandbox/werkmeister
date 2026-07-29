# `sandbox config` — Global Configuration Management

**Date:** 2026-07-19
**Status:** Approved (design) — implementation plan to follow
**Scope:** A `sandbox config` command that owns initial setup and maintenance of
the machine-global sandbox configuration, with a YAML file as the single source
of truth and `SANDBOX_*` environment variables preserved as a derived export for
backward compatibility.

---

## 1. Problem

Machine-global sandbox settings currently live as three hand-maintained exports
in `~/.zshenv`:

```sh
export SANDBOX_WORKSPACES_ROOT="$HOME/workspace/features"
export SANDBOX_REPOS_ROOT="$HOME/workspace"
export SANDBOX_ROOT="$HOME/workspace/sandbox"
```

The same values are duplicated in `claude_desktop_config.json`'s `env` block for
the sandbox MCP server, and the TypeScript CLI reads them ad hoc from `os.environ`
scattered across `apps/cli/src/lib/config.ts`. There is no single command to set them up,
no validation, and three places to keep in sync by hand.

There are two classes of `SANDBOX_*` variable:

- **Machine-global** (this spec): `SANDBOX_ROOT`, `SANDBOX_REPOS_ROOT`,
  `SANDBOX_WORKSPACES_ROOT`, plus optional overrides read by the dashboard/CLI
  (`SANDBOX_MCP_PORT`, `SANDBOX_MODEL_PRICING_YAML`, `SANDBOX_SERVICES_YAML`,
  `SANDBOX_CACHE_FILE`, `SANDBOX_NODE`).
- **Per-feature runtime** (out of scope): `SANDBOX_FEATURE`, `SANDBOX_SLOT`,
  `SANDBOX_TASK`, `SANDBOX_STARTING_PROMPT`, `SANDBOX_WORK_TYPE`, etc. — generated
  per-`up`/per-workspace into `.env` files. These are **not** global config and
  this command does not touch them.

## 2. Goals

1. One command, `sandbox config`, for initial setup and ongoing maintenance.
2. `~/.sandbox/config.yaml` is the **single source of truth**.
3. `SANDBOX_*` env vars remain available for any process outside the sandbox
   CLI, produced *from* the YAML (never hand-edited).
4. `~/.zshenv` references the config instead of hardcoding exports.
5. Fix the MCP server config (`claude_desktop_config.json`) and all internal
   sandbox uses of the environment variables to route through the YAML.
6. Reuse the `_WIZARD_PROMPTS`/`PromptSpec` pattern, extracted so the code is DRY.
7. Follow established CLI conventions (one file per subcommand in
   `cli/commands/`, shared logic in `cli/lib/`, flag-derivation from prompts,
   `--check` mode like `sandbox setup`).

## 3. Non-Goals (YAGNI)

- No browser form for `config` (init-workspace has one because it collects ~8
  fields; config collects two paths — the terminal wizard is enough).
- No `config get/set <key>` scripting subcommands (non-interactive flags plus
  `--show` cover the maintenance cases).
- No management of per-feature runtime variables.

## 4. Decisions (settled during brainstorming)

| Decision | Choice |
|----------|--------|
| **Value precedence in the CLI** | **YAML → built-in default only.** The TypeScript CLI does **not** read `SANDBOX_*` *values* from `os.environ` at runtime. |
| **How env vars reach external processes** | **Generate `~/.sandbox/env.sh`** (a block of `export SANDBOX_*=…`) from the YAML; `~/.zshenv` sources it; the `sandbox` wrapper sources it so children (CLI + node MCP app) inherit. |
| **Desktop MCP config fix** | **Drop the `env` block** on the sandbox server entry — the wrapper self-loads `env.sh`, so the block is redundant. |

### 4.1 The one env var the CLI *does* read: `SANDBOX_CONFIG_FILE`

Because the CLI ignores `SANDBOX_*` *values*, tests and alternate setups need a
way to redirect which YAML is read. `SANDBOX_CONFIG_FILE` names the *path* to the
config file (default `~/.sandbox/config.yaml`). This selects the source of truth;
it never overrides a value inside it — so "single source = the YAML" stays
literally true, and the loader is testable against a temp file.

### 4.2 `sandbox_root` is self-derived, never trusted from config

The running `sandbox` bash script already computes its own root from its
location (`readlink -f "$0"`), and `config.ts:get_sandbox_root()` already falls
back to `__file__`-relative resolution. The CLI keeps self-deriving
`sandbox_root` — a stale YAML/env value can never point it at the wrong checkout.
The YAML/`env.sh` carry `SANDBOX_ROOT` only so *external* processes get it.

## 5. Architecture

### 5.1 Data flow

```
config.yaml ──(sandbox config)──┬─► ~/.sandbox/env.sh    export SANDBOX_*=…  (external procs + node MCP app)
                                ├─► ~/.zshenv            one managed block: source env.sh
                                └─► claude_desktop_config.json   env block REMOVED (wrapper self-loads)

TypeScript CLI      ── reads config.yaml directly (ignores SANDBOX_* values at runtime)
node dashboard  ── reads process.env.SANDBOX_* (fed by env.sh, sourced by the `sandbox` wrapper)
```

### 5.2 Config file schema — `~/.sandbox/config.yaml`

```yaml
# Global sandbox configuration — single source of truth.
# Managed by `sandbox config`; safe to hand-edit, then re-run `sandbox config --check`.
version: 1
paths:
  repos_root:      /Users/<you>/workspace           # canonical source-repo clones
  workspaces_root: /Users/<you>/workspace/features  # per-feature worktree workspaces
  # sandbox_root is self-derived from the running `sandbox` script; stored here
  # only so env.sh can export SANDBOX_ROOT for external processes.
  sandbox_root:    /Users/<you>/workspace/sandbox
overrides:            # OPTIONAL — a key is emitted to env.sh only when non-empty
  mcp_port:            3001
  node:                ""
  services_yaml:       ""
  model_pricing_yaml:  ""
  cache_file:          ""
```

### 5.3 Key → env var mapping (for `env.sh` generation)

| YAML key | Env var |
|----------|---------|
| `paths.sandbox_root` | `SANDBOX_ROOT` |
| `paths.repos_root` | `SANDBOX_REPOS_ROOT` |
| `paths.workspaces_root` | `SANDBOX_WORKSPACES_ROOT` |
| `overrides.mcp_port` | `SANDBOX_MCP_PORT` |
| `overrides.node` | `SANDBOX_NODE` |
| `overrides.services_yaml` | `SANDBOX_SERVICES_YAML` |
| `overrides.model_pricing_yaml` | `SANDBOX_MODEL_PRICING_YAML` |
| `overrides.cache_file` | `SANDBOX_CACHE_FILE` |

`env.sh` is regenerated in full on every write; a header comment marks it as
generated and warns against hand-editing.

## 6. Components

### 6.1 `apps/cli/src/lib/wizard.ts` (NEW) — DRY prompt machinery

Extracted verbatim-in-behavior from `init_workspace.ts`:

- `PromptSpec` dataclass (unchanged fields).
- `prompt(label, default)` — base input helper (Ctrl-C/D → exit 130).
- `prompt_one(spec, default, choices)` — repeat-until-valid loop (pattern check).
- `normalize_multi(value, choices)` — trim/dedupe comma-separated multi-values.
- `run_wizard(prompts, resolved, resolve_default, *, choices_for=None)` — the
  "prompt only missing keys" loop. `resolve_default(spec) -> str` is
  caller-supplied so the runner is not coupled to workspace `Path`s.

`init_workspace.ts` keeps its `_WIZARD_PROMPTS` table and calls `run_wizard`
with `resolve_default=lambda s: s.default_fn(workspace_root) if s.default_fn else ""`.
Its JSON-export helpers (`_build_prompt_spec`, `--print-prompts`,
`--print-form-schema`) are unaffected — they iterate the same `PromptSpec`
objects.

### 6.2 `apps/cli/src/lib/global_config.ts` (NEW) — config I/O + projections

Self-contained (does **not** import `apps/cli/src/lib/config.ts`, to avoid an import
cycle; it self-derives `sandbox_root` from `__file__` when needed):

- `config_path() -> Path` — `SANDBOX_CONFIG_FILE` or `~/.sandbox/config.yaml`.
- `load() -> dict` — parse YAML; missing file → `{}` (callers apply defaults).
- `save(cfg: dict) -> None` — write YAML with the managed header.
- `_CONFIG_PROMPTS: tuple[PromptSpec, ...]` — `repos_root`, `workspaces_root`
  (patterns: absolute path; defaults seeded from current env → `~/workspace`
  during first-run migration).
- `render_env_sh(cfg) -> str` — the `export SANDBOX_*=…` text (skips empty
  overrides; quotes values).
- `write_env_sh(cfg) -> Path` — write `~/.sandbox/env.sh`.
- `ensure_zshenv_sources(zshenv=~/.zshenv) -> None` — idempotently install a
  managed block (`# >>> sandbox config >>>` … `# <<< sandbox config <<<`)
  containing `[ -f "$HOME/.sandbox/env.sh" ] && . "$HOME/.sandbox/env.sh"`,
  replacing any prior block and removing the old hardcoded exports.
- `patch_desktop_config(path) -> bool` — if the sandbox server entry has an
  `env` block, remove it; return whether a change was made. No-op when the file
  or entry is absent. Idempotent.
- `check(cfg) -> list[str]` — return a list of drift problems (empty = OK):
  YAML present & parses, `paths.*` exist, `.zshenv` sources `env.sh`, `env.sh`
  content matches `render_env_sh(cfg)`, Desktop `env` block absent.

Dotfile and JSON writes are surgical (managed block / single key) and idempotent
so re-running is safe.

### 6.3 `apps/cli/src/commands/config.ts` (NEW) — the command

`run(args)`:

1. `resolved = load()` flattened to the prompt keys; apply CLI flags
   (`--repos-root`, `--workspaces-root`, derived from `_CONFIG_PROMPTS`).
2. If any required key still missing **and** stdin is a TTY → `run_wizard`,
   seeding defaults from current config → current env → built-in default
   (migration path: an existing setup presses Enter through).
3. Always self-derive `sandbox_root` from the running script.
4. `save()`, `write_env_sh()`, `ensure_zshenv_sources()`,
   `patch_desktop_config()`.
5. Print a summary of what was written/changed.

Flags:

- `--repos-root PATH`, `--workspaces-root PATH` — non-interactive set.
- `--show` — print the resolved config and each value's origin (YAML / default);
  no writes.
- `--check` — run `check()`; print problems; exit nonzero on drift. Mirrors
  `sandbox setup --check`.

### 6.4 `apps/cli/src/lib/config.ts` (EDIT) — route reads through the YAML

The root-cause change: internal value resolution reads the YAML, not the env.

- `get_repos_root()` → `load().paths.repos_root` if set, else `~/workspace`.
  Drops the `SANDBOX_REPOS_ROOT` env read.
- `resolve_workspace()` → workspaces root from `load().paths.workspaces_root`
  if set, else `~/workspace`. Drops the `SANDBOX_WORKSPACES_ROOT` /
  `SANDBOX_WORKSPACE_ROOT` / `WORKSPACE` env reads and the deprecated aliases.
  The `--workspace` flag override and cwd auto-detection are unchanged.
- `get_sandbox_root()` → **unchanged** (self-derives; already ignores nothing
  load-bearing — keeps the `__file__` fallback, drops only the env read).

Every existing caller of these helpers inherits YAML-sourced values with no
per-caller edit.

### 6.5 `sandbox` (EDIT) — wrapper sources `env.sh`

**Ordering (pinned):** source `env.sh` **first**, then let the existing
self-derivation of `SANDBOX_ROOT` re-assert last, so the running checkout's
location always wins over a possibly-stale `env.sh` value. Concretely, reorder
the top of the script to:

```sh
set -euo pipefail

# Load machine-global config exports (generated by `sandbox config`) so the
# TypeScript CLI and the node MCP app both inherit SANDBOX_* without a per-client
# env block.
[ -f "$HOME/.sandbox/env.sh" ] && . "$HOME/.sandbox/env.sh"

# The running checkout is authoritative for SANDBOX_ROOT — re-derive and export
# AFTER sourcing env.sh so a stale value there can never win.
SANDBOX_ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export SANDBOX_ROOT
```

### 6.6 `~/.zshenv` (EDIT)

Replace the three hardcoded exports with the managed block written by
`ensure_zshenv_sources()`.

### 6.7 `claude_desktop_config.json` (EDIT)

Remove the `env` block from the sandbox server entry (done by
`patch_desktop_config`).

### 6.8 `cli/main.ts` (EDIT)

Register the `config` subparser with `--repos-root`, `--workspaces-root`,
`--show`, `--check`, following the existing `add_parser` pattern; dispatch to
`cli.commands.config.run`.

## 7. Migration & backward compatibility

- **First run:** with no `config.yaml`, the wizard seeds defaults from the
  currently-exported `SANDBOX_*` env values (read **once**, at setup time, to
  pre-fill prompts — not runtime value resolution), so an existing machine is
  migrated by accepting the shown defaults.
- **External processes** keep seeing `SANDBOX_*` via `env.sh` (sourced by
  `.zshenv` for interactive/login shells and by the wrapper for CLI/MCP).
- **Removed:** the deprecated `SANDBOX_WORKSPACE_ROOT` and `WORKSPACE` aliases in
  `resolve_workspace()`.

## 8. Testing

- `wizard.ts`: extraction preserves behavior — cover `prompt_one` pattern
  rejection, `normalize_multi` dedupe/unknown-warn, `run_wizard` skipping
  already-resolved keys.
- `global_config.ts`: load/save round-trip; `render_env_sh` (empty overrides
  skipped, quoting); `ensure_zshenv_sources` idempotent against a temp file
  (run twice → single block, old exports gone); `patch_desktop_config` idempotent
  against a temp JSON (removes `env`, no-op when absent); `check` reports each
  drift class.
- `config.ts`: `get_repos_root` / `resolve_workspace` read a temp YAML via
  `SANDBOX_CONFIG_FILE`; default fallback when the file is absent; `--workspace`
  override still wins.
- `commands/config.ts`: non-interactive flags write the expected YAML/env.sh;
  `--check` exit code on drift; `--show` output.
- **Migrate existing tests** that `monkeypatch.setenv("SANDBOX_WORKSPACES_ROOT", …)`
  to write a temp `config.yaml` and point `SANDBOX_CONFIG_FILE` at it.

## 9. Files touched

**New:** `apps/cli/src/lib/wizard.ts`, `apps/cli/src/lib/global_config.ts`,
`apps/cli/src/commands/config.ts`, `apps/cli/src/lib/__tests__/global_config.test.ts`,
`apps/cli/src/lib/__tests__/config_command.test.ts` (+ wizard cases).

**Edit:** `apps/cli/src/commands/init_workspace.ts` (import from `wizard`),
`apps/cli/src/lib/config.ts`, `cli/main.ts`, `sandbox`, `~/.zshenv`,
`claude_desktop_config.json`, existing tests that set `SANDBOX_*` env.
