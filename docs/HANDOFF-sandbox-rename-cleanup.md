# Handoff — sandbox rename: remaining fixes

**Date:** 2026-07-28
**Branch:** `main`
**Audience:** an engineer (or agent) continuing this work with no prior context.

The `developer-sandbox` → `sandbox` rename landed, along with a plugin marketplace
manifest and a scrub of hardcoded ingress hosts out of the plugin skills. This
note lists what is **still broken or undecided**, in priority order.

**Nothing in this session is committed.** `git status` shows the full working set.

---

## 0. Context — what changed already

- **`.claude-plugin/marketplace.json`** created at the repo root. Name `sandbox`,
  serving `./plugins/sandbox-tools`. Verified with the real CLI
  (`claude plugin marketplace add <repo>` → `✔ Successfully added marketplace: sandbox`),
  then removed again so `sandbox setup` adds the GitHub-sourced one cleanly.
- **`REQUIRED_PLUGINS`** (`apps/cli/src/lib/machine_setup.ts`) now uses
  `marketplace: "sandbox"` to match that manifest.
- **Ingress hosts** removed from every `plugins/sandbox-tools` skill; they now
  derive from `ingress.local_domain` in `~/.sandbox/config.yaml`.
- **`superpowers`** added as an opt-in plugin (`OPTIONAL_PLUGINS` + wizard section 6).
- **Old identity erased** from source: `developer-sandbox`, `trustradius`,
  `apps/sandbox-cli/cli`, and the `multi-feature` branch. `apps/cli` package
  renamed `sandbox-cli`.

`sandbox setup --check` currently reports:

```
✗ plugin sandbox-tools: marketplace sandbox not added (source: jayandcory/sandbox@main)
```

That is expected until the manifest is pushed — see item 1.

---

## 1. Push, then re-run `sandbox setup` — BLOCKING

`marketplace.json` exists locally but **is not on the remote yet**, and the
marketplace source is `jayandcory/sandbox@main`. Until it is pushed, setup keeps
failing exactly as before.

```bash
git add -A && git commit && git push
sandbox setup          # should now add marketplace `sandbox` and install sandbox-tools
```

**Anyone who previously added the old marketplace must drop it first** — the name
changed from `developer-sandbox` to `sandbox`, and a stale entry will shadow it:

```bash
claude plugin marketplace remove developer-sandbox   # if present
```

---

## 2. `plugin_check.ts` looks in the wrong place — drift detection is dead

`defaultRepoPluginDir()` (`apps/cli/src/lib/plugin_check.ts:30`) resolves to
`$SANDBOX_ROOT/plugins/sandbox-tools`. `SANDBOX_ROOT` is `apps/cli`, so it looks
for `apps/cli/plugins/sandbox-tools` — which **does not exist**. The plugin lives
at the repo root: `plugins/sandbox-tools/`.

Consequence: `repoPluginVersion()` always returns `null`, so the "your installed
plugin lags the repo" warning can never fire. `syncPlugin`'s `driftProbe` for
`sandbox-tools` is likewise inert.

Pick one:
- **(a)** Point `defaultRepoPluginDir()` one level up (`path.join(getSandboxRoot(), "..", "..", "plugins", PLUGIN_NAME)`), or
- **(b)** Move `plugins/` under `apps/cli/` and update `marketplace.json`'s
  `source` to `./apps/cli/plugins/sandbox-tools`.

(b) keeps the CLI self-contained; (a) is the one-line fix. Either way add a test —
there is none covering this path today.

---

## 3. Generated CLAUDE.md emits dead links

`apps/cli/src/lib/claude_md.ts:171,268` link to
`{GITHUB_REPO_BASE}/blob/main/docs/code-style-guide.md`, and lines 235 / the
`sb-handoff` skill reference `docs/notes-conventions.md`.

**Neither file exists anywhere in this repo.** They lived in the pre-rename repo.
The org and branch are now correct, so the links resolve to a real repo and 404
on the path.

Options: port both docs in, repoint at whatever replaced them, or drop the link
lines. Until then every generated workspace ships two dead links.

---

## 4. Hardcoded machine-specific values still in the CLI

Same class of bug already fixed in the plugin skills, but `claude_md.ts` was out
of scope and still bakes them in:

| Value | Where | Should come from |
|---|---|---|
| `https://sb-web.local.sandbox.com` (10 occurrences) | `claude_md.ts:58,79,390,401,462,467,…` | `ingress.local_domain` + a routed service |
| `.local.sandbox.com` cookie domain | `claude_md.ts:76` | same |
| `https://hgdata.atlassian.net` (4 occurrences) | `claude_md.ts:51,246` | `jira.base_url` in `~/.sandbox/config.yaml` |

Two extra wrinkles:
- `sb-web` **is not a service in the registry** — `~/.sandbox/services.yaml` has
  `rest-hello` and `next-hello`. The generated docs point at a host that does not
  resolve on a default machine.
- `hgdata.atlassian.net` is the old org's Jira; the configured one is
  `jory-group.atlassian.net`. The value is already loadable via `gc.loadJira()`.

`plugins/sandbox-tools/skills/sandbox-diagnose/SKILL.md` has a working pattern to
copy (derive domain, join to service name).

---

## 5. Skills depend on `dist/`, which is gitignored

`sandbox-caddy-reload` Step 2 and `sandbox-diagnose` Step 4 previously shelled
into the **Python** CLI (`uv run python -c "from cli.lib.caddy import
count_compiled_routes"`) — dead since the TypeScript port. They now run:

```bash
node --input-type=module -e "
const {countCompiledRoutes} = await import(process.env.SANDBOX_ROOT + '/dist/lib/caddy.js');
..."
```

Verified working against synthetic `caddy adapt` output (counts nested
`reverse_proxy` handlers correctly). **But `dist/` is in `.gitignore`**, so these
steps need `npm --prefix apps/cli run build` first, and fail confusingly if it was
never run.

Fix by either adding an explicit build precondition to both skills, or exposing a
`sandbox proxy-routes --count` subcommand so the skills call the CLI instead of
reaching into build output. The second is cleaner — the skills already treat
`sandbox proxy-reload` as the primary path.

---

## 6. `package-lock.json` is stale

`apps/cli/package.json` was renamed `developer-sandbox` → `sandbox-cli`, but the
lockfile still carries the old name (1 occurrence). Run `npm install` at the repo
root and commit the result.

Note the name could **not** be `sandbox`: the root package already owns that.
npm tolerates the duplicate (tested), but `npm -w sandbox` and
`turbo --filter=sandbox` become ambiguous, so `sandbox-cli` was chosen.

---

## 7. Decision needed — ~52 Python references in `apps/cli/src`

The rename erased *provenance* ("ported from `worker.py`", "Source of truth:
~/workspace/developer-sandbox"). It deliberately left references where Python
explains **current behavior**:

- `generate.ts` — the `.j2` templates rely on Python truthiness and dict
  `get`/`items`; this is why `_stampDictMethods` exists at all
- `gate.ts` / `standards.ts` — `fnmatch` semantics where `*` crosses `/`
- `proc.ts` — `timeout` is in **seconds**, an unusual choice that comment justifies
- `notes.ts` — `repr(list)` / `repr(tuple)` output formats that are contract-shaped

Deleting the word "Python" there destroys the explanation rather than the history.
If they must go, each needs rewriting to describe the behavior directly — roughly
52 individual judgment calls, not a substitution. **This is a decision, not a task.**

---

## 8. Pre-existing test failures (not caused by the rename)

`npx vitest run` from the repo root: `5 failed | 2845 passed | 8 skipped`.
Verified identical on a clean tree via `git stash`, so these predate this work:

- `apps/claudeck/tests/unit/backend/paths.test.js` — `CLAUDECK_HOME` env test;
  expects `undefined`, gets `/Users/<user>/.claudeck`. Env-dependent.
- `apps/claudeck/tests/unit/frontend/plugin-loader.test.js` — 3 failures
- `apps/claudeck/tests/perf/ws-perf.test.js` — throughput, likely timing-sensitive
- Several `.mjs` files report `No test suite found` — they are `node:test` style
  and vitest cannot collect them. The assertions inside pass when run directly
  (`packages/sandbox-driver/resolve-bin.test.mjs` prints `✔`). Either exclude
  `**/*.test.mjs` from the vitest config or port them.

`apps/cli` alone is green: **149 passed**, typecheck clean.

---

## 9. Behavior change to be aware of

`packages/sandbox-driver/sandbox.ts` no longer accepts the pre-rename layouts
`cli/` or `apps/sandbox-cli/cli` when resolving the CLI wrapper — only
`apps/cli`. Older checkouts will fail to resolve. Intentional, but it will look
like a regression if someone hits it.

---

## 10. Housekeeping

- Local tag `archive/origin-main-pre-force` pins `62530a5`, the remote `main`
  that was replaced by force-push (5 commits, incl. merged PR #1, plus
  `compose.yml` and `bin/start-store` which exist nowhere else). Keeping it
  prevents `git gc` from reclaiming those objects. Delete with
  `git tag -d archive/origin-main-pre-force` once you are sure.
- `plugins/sandbox-tools/README.md` still documents the install as
  `/plugin install sandbox-tools@sandbox` — correct, but only once item 1 ships.
