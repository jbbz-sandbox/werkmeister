# Keeping docs in sync with the code

Docs here drift in a few predictable ways: a command or MCP tool is renamed, a
file moves, an old name lingers (`~/.sandbox`, `npm run`, Stellwerk), or a doc <!-- docs-check: ignore -->
restates a fact that lives in code or config and then goes stale. The
2026-10-22 sweep (PR #354) fixed about a hundred of these by hand. This page
covers what now catches them automatically and what is still open.

## `pnpm run docs:check`

[`scripts/check-docs.mjs`](../scripts/check-docs.mjs) reads every tracked
`.md` file and fails on:

| Check | Source of truth |
| --- | --- |
| Retired names and paths (`k8s-connect`, `infra/config/`, `npm run`, Stellwerk, …) | the `RETIRED` list in the script <!-- docs-check: ignore --> |
| Relative Markdown links that don't resolve | the file system |
| Repo paths in code spans (`apps/…`, `packages/…`, `plugins/…`, `docs/…`); `file.ts::symbol` also checks the symbol | the file system <!-- docs-check: ignore --> |
| `werkmeister <command> --flag` at the start of a code span or shell line | the built CLI's `__complete` |
| MCP tool names (`` `x` tool ``, `MCP tool `x``, `mcp__plugin_werkmeister_werkmeister__x`) | `registerTool` / `registerAppTool` in `apps/werkmeister-mcp/src`, plus the plugin's `*_TOOL` constants <!-- docs-check: ignore --> |

It runs in CI after the build. Locally, run `pnpm run build` first.

**When it fails:**

- **The doc is stale:** fix the doc.
- **The line is meant to name the old thing** (a resolved known issue, a migration note, history): add `<!-- docs-check: ignore -->` to that line. In a table row, put it inside the last cell.
- **You just retired a name:** add it to `RETIRED` with what replaces it, so the next mention fails CI instead of waiting for a sweep.

Changelogs, `docs/superpowers/`, `docs/research/` and the naming, context-management and SCAMPER research docs are skipped as point-in-time records.

**What it does not catch:**

- A subcommand's flags (`pr watch --install`). Only flags straight after the command word are checked.
- Commands run through the deprecated `sandbox` launcher.
- Prose claims ("only one dependency", "all 19 tools").
- Line numbers (`gate.ts:290`).
- Anything about other repos (`demo-services`).

## Writing docs that stay checkable

- Cite a symbol, not a line: `` `packages/werkmeister-core/src/caddy.ts::reloadCaddy` `` is checked, `caddy.ts:325` rots.
- Don't state counts or copy lists that live in code ("all 21 tools", the allow/deny lists). Link to the source, or generate the list (option 2 below).
- Put commands in code spans, so the command check sees them.
- When you rename a command, path, tool or config key, run `docs:check` before opening the PR.

## Options not yet taken

Ranked by drift caught per effort, as proposed with the check above.

1. **Generated sections.** Mark a region `<!-- generated:<name> -->` … `<!-- /generated -->`. A `docs:gen` script rewrites it from source, and `docs:check` fails if the output would change (the same check-in-and-verify pattern as `licenses`). Candidates, most drift-prone first:
   - the autonomous allow/deny lists in `docs/context-strategies.md` (from `hooks_gen.ts`)
   - the MCP tool list and count (from the registrations)
   - the CLI command reference in `docs/users-guide.md` (from commander's command and option descriptions)
   - the README workspaces table (from each `package.json`)
   - the changesets `fixed` group and the release `needs:` in the README
2. **TSDoc `{@link}` in code comments, checked by TypeDoc.** Code comments that name another symbol or file drift too (the esbuild header, comments linking to deleted specs). Write them as `{@link reloadCaddy}` and run TypeDoc over `werkmeister-core` in CI with `--emit none` and `invalidLink` validation as errors. Skip publishing an API site: `werkmeister-core` is private, so a site would have almost no readers.
3. **Run the skills' shell snippets.** The plugin skills' bash blocks are instructions Claude executes, and a wrong path there fails at runtime. Extracting and smoke-running them (e.g. in `apps/cli/bdd`) costs more than the checks above. Revisit if skills keep breaking after `docs:check`.
4. **Subcommand flags.** Walk commander's subcommands (or extend `__complete`) so `pr watch --install` is checked too.

## Open follow-ups from the 2026-10-22 sweep

Found while fixing the docs. Each one is either a code issue or needs a decision, so none of them is a doc edit:

- **`~/.sandbox` mounts.** This repo's `.sandbox/services.yaml` hardcodes `{{home}}/.sandbox` for mounts, locks and caches. On a machine that only has `~/.werkmeister`, Docker creates an empty `~/.sandbox` instead.
- **About 96 `sandbox <cmd>` calls in the skills.** They work through the deprecated launcher, and the CLI's own help text mostly says `sandbox` too. Renaming them is one decision, not a doc fix.
- **`docs/ponytail-debt.md` is behind.** It lists 26 markers; about 40 exist. Run `/ponytail-debt` to rebuild it.
- **`apps/cli/CONVENTIONS.md` dependency policy** ("no new npm dependencies beyond commander, nunjucks, yaml") no longer matches the code. Either update the policy or decide it still stands.
- **Full system recovery** in `docs/troubleshooting-advanced.md` runs `docker compose -f shared-infra.yml` bare, which skips the generated override and environment that `composeInvocation()` adds. It probably needs a CLI command instead.
