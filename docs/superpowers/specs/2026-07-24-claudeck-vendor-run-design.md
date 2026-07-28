# Claudeck Adoption — Phase 1: Vendor & Run

**Date:** 2026-07-24
**Status:** Design approved; spec under review
**Scope:** Phase 1 of a 3-phase effort to give each feature workspace Claude Code chat, rooted at the workspace root, by adopting the upstream claudeck project.

---

## Background & goal

The user wants Claude Code chat per feature workspace, with the chat client rooted at the feature workspace's directory. Investigation established:

- `apps/claudeck` in this repo is a **minimal namesake reimplementation** (an MCP server + a basic workspace dashboard built earlier in this effort). It has none of the real project's architecture and **no chat**.
- The real project — [`hamedafarag/claudeck`](https://github.com/hamedafarag/claudeck) — is a full Claude chat/terminal web app where chat is a **core feature**. It drives Claude via the `@anthropic-ai/claude-code` SDK, streams over WebSocket `/ws`, persists sessions/memory/costs in SQLite (`~/.claudeck/data.db`), and has a full-stack plugin system.
- In claudeck, a **"project" = a repository/directory**, sourced from `~/.claudeck/config/repos.json` (managed by the built-in `repos` plugin). Selecting a project sets the directory context for chat — this is exactly the "chat rooted at the workspace root" requirement.

**Decision:** Adopt upstream claudeck (vendored into the monorepo), and later re-home our sandbox workspace management as a claudeck plugin.

### Gating facts (resolved)

- **License:** upstream is **MIT** (© 2026 Hamed Farag). Vendoring is permitted provided the copyright notice + license text are retained.
- **Billing:** upstream uses the `@anthropic-ai/claude-code` SDK, not `claude -p`. Claude Code resolves credentials as: `ANTHROPIC_API_KEY` if set, else the `claude login` (Pro/Max) subscription — API key wins if present. Documentation does not *explicitly* confirm the SDK's resolution path, so we treat subscription billing as **configure-and-verify**: run with `ANTHROPIC_API_KEY` unset and confirm via `/usage` that consumption draws from the subscription, not API credits.

---

## Phase decomposition

1. **Phase 1 — Vendor & run (this spec).** Vendor upstream claudeck into `apps/claudeck`, get it building/running in the monorepo, chat working against a test project, subscription billing verified.
2. **Phase 2 — Feature workspaces as projects.** Populate claudeck's project list from `sandbox-driver`'s workspaces so each feature is selectable and chat roots at its workspace dir (generate `~/.claudeck/config/repos.json` from `listWorkspaces()`). *Delivers the primary goal.*
3. **Phase 3 — Sandbox management as a claudeck plugin.** Re-home create/list/status/PRs (and the dashboard built earlier) into a claudeck full-stack plugin (`server.js` + `client.js` tab), per the `repos`/`claude-editor` plugin model.

Each phase gets its own spec → plan → implement cycle.

---

## Phase 1 design

### 1. Vendoring mechanism & provenance
- Snapshot copy via `npx degit hamedafarag/claudeck` into `apps/claudeck` (not a submodule/subtree — we will modify it in Phase 3, so a clean editable copy is simplest).
- Retain upstream `LICENSE`. Add `apps/claudeck/VENDORED.md` recording: source repo URL, commit SHA, and vendor date, so future updates can be diffed/pulled.
- Optionally add a `claudeck-upstream` git remote to ease future merges (no submodule).

### 2. Monorepo integration
- `apps/claudeck` keeps upstream's own `package.json` (express@4, ws@8, better-sqlite3@11, @anthropic-ai/claude-code, web-push, dotenv) and its module setup **as-is** — no ESM/CJS conversion.
- Already under `apps/*`, so root `npm install` includes it.
- No build step (plain JS). Launch model: **first run** `node cli.js` (prompts once, writes `PORT=9009` to `~/.claudeck/.env`); **thereafter** upstream's `npm start` (= `node server.js`, which reads `PORT` from `~/.claudeck/.env`). Turbo `build` is a no-op for this app (exclude or empty).
- **Risk:** `better-sqlite3` is a native module. Prebuilt binaries generally cover macOS arm64; a miss requires Xcode Command Line Tools. Node engine: upstream `>=18`, repo `>=20` — compatible.

### 3. State, config & port
- State in **global `~/.claudeck/`** (`.env`, `data.db`, `config/repos.json`) — upstream default (decision: chosen over repo-local isolation for simplicity; revisit if multiple checkouts collide).
- Port **9009** (no collision: sandbox-dashboard is 3001).
- Run **without** `--auth` for local single-user use.
- **Security:** claudeck's chat executes tools server-side (privileged). It must stay loopback-bound. Enable `--auth` if ever exposed beyond localhost.

### 4. Billing configuration & verification
- Ensure `ANTHROPIC_API_KEY` is **unset** in claudeck's runtime environment so the SDK uses the subscription.
- **Verification (acceptance-critical):** start claudeck, add a throwaway test project, send one chat message, and confirm via `/usage` that it drew from the Claude subscription, not API credits.

### 5. Removed / kept (decision: remove fork in Phase 1)
- **Remove** the minimal fork: `apps/claudeck/src/`, `public/index.html`, `web-server.ts`, `plugins/sandbox-dashboard/`, `claudeck.config.json`, its `tsconfig.json`. Recoverable from git history; sandbox logic returns as a plugin in Phase 3.
- **Keep** `packages/sandbox-driver` (the Phase 3 plugin will use it).
- `sandbox-dashboard` app: untouched.

### 6. Acceptance criteria
- First run `node cli.js` sets port 9009; subsequently `cd apps/claudeck && npm start` launches claudeck on `:9009`.
- Browser loads the claudeck UI.
- A test project can be added and a chat conversation held with Claude, rooted in that project directory.
- Billing confirmed to draw from the Claude subscription (`ANTHROPIC_API_KEY` unset; `/usage` check).
- MIT `LICENSE` retained; `VENDORED.md` records provenance.

### Testing
Phase 1 is a vendoring/run task; the check is the acceptance smoke test above (launch + chat + `/usage`). No unit tests added in this phase.

---

## Risks & open items
- **Native build** (`better-sqlite3`) under monorepo install (see 2).
- **Global state collisions** across multiple repo checkouts sharing `~/.claudeck` (accepted for Phase 1).
- **Privileged chat** — keep loopback-only (see 3).
- **SDK billing** not documented explicitly — mitigated by verify-via-`/usage` (see 4).
- Large vendored diff is inherent to the adoption choice.

## Out of scope (Phase 1)
- Integrating feature workspaces as projects (Phase 2).
- Re-homing sandbox management as a plugin (Phase 3).
- Any modification of upstream claudeck's own behavior beyond what's needed to run it.
