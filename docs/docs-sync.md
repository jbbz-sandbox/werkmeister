# Keeping docs in sync with the code

Docs here drift in a few predictable ways: a command or MCP tool is renamed, a
file moves, an old name lingers (`~/.sandbox`, `npm run`, Stellwerk), or a doc <!-- docs-check: ignore --> <!-- name-check: ignore -->
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
| `werkmeister <command>` or `w9r <command>` at the start of a code span or shell line, and every `--flag` after it up to a bare `--` | the built CLI's `__reference` |
| Bare `<placeholder>`s outside code, which GitHub drops silently | `HTML_TAGS` in the script (the elements GitHub keeps) |
| `#anchor` links, in the same doc or another `.md` | that doc's headings, as GitHub slugs them |
| MCP tool names (`` `x` tool ``, `MCP tool `x``, `mcp__plugin_werkmeister_werkmeister__x`) | `registerTool` / `registerAppTool` in `apps/werkmeister-mcp/src`, plus the plugin's `*_TOOL` constants <!-- docs-check: ignore --> |
| Generated regions that `docs:gen` would rewrite (hand-edited, or the source moved on), unknown region names, unclosed markers | `scripts/gen-docs.mjs` |

It runs in CI after the build. Locally, run `pnpm run build` first.

**When it fails:**

- **The doc is stale:** fix the doc.
- **The line is meant to name the old thing** (a resolved known issue, a migration note, history): add `<!-- docs-check: ignore -->` to that line. In a table row, put it inside the last cell.
- **You just retired a name:** add it to `RETIRED` with what replaces it, so the next mention fails CI instead of waiting for a sweep.
- **A generated region is out of date:** run `pnpm run docs:gen` and commit the result. To change its wording, change the source it names below.

Changelogs, `docs/superpowers/`, `docs/research/` and the naming, context-management and SCAMPER research docs are skipped as point-in-time records.

**What it does not catch:**

- Short flags (`-s backend`).
- Whether a flag fits the action it follows: flags hang on the command, so `pr open --install` passes.
- Anchors into files other than Markdown (`tree.ts#L98`).
- Prose claims ("only one dependency", "all 19 tools").
- Line numbers (`gate.ts:290`).
- Anything about other repos (`demo-services`).

## Generated regions: `pnpm run docs:gen`

[`scripts/gen-docs.mjs`](../scripts/gen-docs.mjs) (SW-81) rewrites every region marked `<!-- generated:<name> -->` … `<!-- /generated -->` in the tracked Markdown from its source, as plain Markdown. Like `docs:check`, it reads the built core and CLI, so run `pnpm run build` first. A retired name inside a region is the source's own and isn't flagged; every other check still applies.

| Region | Where | Source |
| --- | --- | --- |
| `autonomous-allow`, `autonomous-deny` | `docs/context-strategies.md` | `packages/werkmeister-core/src/hooks_gen.ts::autonomousRules`, `AUTONOMOUS_DENY` |
| `mcp-tools` | `apps/werkmeister-mcp/README.md` | each `registerTool` / `registerAppTool` call's name and `title` in `apps/werkmeister-mcp/src` |
| `cli-reference` | `docs/users-guide.md` | commander's commands, groups, arguments and options, through the CLI's hidden `__reference` mode, plus each command's `apps/cli/src/commands/<command>.help.md` |
| `workspaces` | `README.md` | each `apps/*` and `packages/*` `package.json`'s `name` and `description` |

A new region is a key in `loadRegions()` plus its markers in a doc.

`docs:gen` also writes the CLI's man pages from the same source (SW-180): `apps/cli/man/werkmeister.1` lists the commands by group, and `werkmeister-<command>.1` holds one command's synopsis, options and help.md. It lists them in the `man` array of `apps/cli/package.json`, which npm links on a global install. `docs:check` fails when a page or that array differs from what `docs:gen` would write. To change a command's long help, edit its help.md: `--help` prints it, and the guide and man pages are generated from it. The help.md files themselves are skipped by `docs:check`, because their links are written to resolve from `docs/users-guide.md`, where they are checked.

## Writing docs that stay checkable

- Cite a symbol, not a line: `` `packages/werkmeister-core/src/caddy.ts::reloadCaddy` `` is checked, `caddy.ts:325` rots.
- Don't state counts or copy lists that live in code ("all 21 tools", the allow/deny lists). Link to the source, or generate the list (a region above).
- Put commands in code spans, so the command check sees them.
- When you rename a command, path, tool or config key, run `docs:check` before opening the PR.

## Options not yet taken

Ranked by drift caught per effort, as proposed with the check above.

1. **More generated regions.** Implemented for four regions (SW-81, above). Still a candidate: the changesets `fixed` group and the release `needs:` in the README.
2. **TSDoc `{@link}` in code comments, checked by TypeDoc.** Code comments that name another symbol or file drift too (the esbuild header, comments linking to deleted specs). Write them as `{@link reloadCaddy}` and run TypeDoc over `werkmeister-core` in CI with `--emit none` and `invalidLink` validation as errors. Skip publishing an API site: `werkmeister-core` is private, so a site would have almost no readers. Implemented (SW-82) as `pnpm --filter werkmeister-core run docs:links` (config in `packages/werkmeister-core/typedoc.json`), run by the CI `test` job; `notExported` is off, and a link to a symbol in another module needs the module name, as in `{@link sandbox.resolveSandboxBin}`. <!-- name-check: ignore -->
3. **Run the skills' shell snippets.** The plugin skills' bash blocks are instructions Claude executes, and a wrong path there fails at runtime. Extracting and smoke-running them (e.g. in `apps/cli/bdd`) costs more than the checks above. Revisit if skills keep breaking after `docs:check`.

## Open follow-ups from the 2026-10-22 sweep

Found while fixing the docs. Each one is either a code issue or needs a decision, so none of them is a doc edit:

- **`docs/ponytail-debt.md` is behind.** It lists 26 markers; about 40 exist. Run `/ponytail-debt` to rebuild it.
- **`apps/cli/CONVENTIONS.md` dependency policy** ("no new npm dependencies beyond commander, nunjucks, yaml") no longer matches the code. Either update the policy or decide it still stands.
- **Full system recovery** in `docs/troubleshooting-advanced.md` runs `docker compose -f shared-infra.yml` bare, which skips the generated override and environment that `composeInvocation()` adds. It probably needs a CLI command instead.
