# Claudeck Vendor & Run (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the upstream `hamedafarag/claudeck` app into `apps/claudeck`, run it in this monorepo, and verify Claude chat works against a test project using the Claude subscription (not API credits).

**Architecture:** Replace the minimal namesake fork at `apps/claudeck` with a snapshot copy of upstream claudeck (a full Node chat app: `express` + `ws` + `better-sqlite3` + `@anthropic-ai/claude-code`). It runs as an npm workspace with its own `package.json`, keeps state in global `~/.claudeck/`, and is launched with `node cli.js`. No code is written this phase — it is vendoring, integration, and verification. `packages/sandbox-driver` is retained for a later phase.

**Tech Stack:** Node ≥18, npm workspaces, Turborepo, `degit` (vendoring), upstream deps (express@4, ws@8, better-sqlite3@11, @anthropic-ai/claude-code, web-push, dotenv).

## Global Constraints

- Retain upstream `LICENSE` (MIT, © 2026 Hamed Farag) and add `apps/claudeck/VENDORED.md` recording source repo + commit SHA `bb0fd54db457ccf10de97c8407102e54e4b4280a` + vendor date `2026-07-24`.
- Do **not** modify upstream claudeck's own files beyond adding `VENDORED.md` (keep the snapshot pristine for future updates).
- Run claudeck with `ANTHROPIC_API_KEY` **unset** so the SDK uses the `claude login` subscription. Subscription billing is confirmed by inspection, not assumed.
- Port **9009**. State in global `~/.claudeck/` (default; not repo-local).
- Keep `packages/sandbox-driver`. Do **not** touch `apps/sandbox-dashboard`.
- Work stays on the `claudeck` branch (already checked out; not `main`).

---

### Task 1: Preserve current work in git (safety checkpoint)

`apps/claudeck/` is currently **untracked** — the minimal fork, dashboard, and sandbox plugin exist only in the working tree. `packages/sandbox-driver` config files and the `sandbox-dashboard` edits are also uncommitted. Committing now puts them in history so Task 2 can remove the fork safely and its plugin logic survives for Phase 3.

**Files:**
- Modify (commit): entire working tree on branch `claudeck`

**Interfaces:**
- Produces: a git commit containing `apps/claudeck/**` (the fork), `packages/sandbox-driver/**`, and the `apps/sandbox-dashboard` extraction edits — recoverable by SHA in later phases.

- [ ] **Step 1: Confirm branch and review what will be committed**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
git branch --show-current   # expect: claudeck
git status --short
```
Expected: branch is `claudeck`; status lists the untracked `apps/claudeck/`, `docs/`, `packages/sandbox-driver/*`, and modified `apps/sandbox-dashboard/*` + lockfile.

- [ ] **Step 2: Stage everything**

Run:
```bash
git add -A
git status --short
```
Expected: all the above now staged (`A`/`M`/`R` in the left column).

- [ ] **Step 3: Commit the checkpoint**

Run:
```bash
git commit -m "chore: checkpoint sandbox-driver extraction + minimal claudeck fork before vendoring upstream

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds.

- [ ] **Step 4: Verify the fork is now in history**

Run:
```bash
git log --oneline -1
git show --stat HEAD | grep -c "apps/claudeck/"
```
Expected: the new commit is HEAD; the grep count is ≥1 (fork files are in the commit and thus recoverable).

---

### Task 2: Remove the fork and vendor upstream claudeck

**Files:**
- Delete: everything under `apps/claudeck/` (the minimal fork — now in history from Task 1)
- Create: `apps/claudeck/**` (upstream snapshot via degit)
- Create: `apps/claudeck/VENDORED.md`

**Interfaces:**
- Produces: `apps/claudeck/cli.js`, `apps/claudeck/server.js`, `apps/claudeck/package.json` (name `claudeck`), `apps/claudeck/LICENSE`, `apps/claudeck/VENDORED.md`, plus `server/`, `public/`, `plugins/`, `config/`, `db/`.

- [ ] **Step 1: Remove the fork directory**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
rm -rf apps/claudeck
```
Expected: `apps/claudeck` gone (recoverable from the Task 1 commit).

- [ ] **Step 2: Vendor upstream at the recorded commit**

Run:
```bash
npx --yes degit hamedafarag/claudeck#bb0fd54db457ccf10de97c8407102e54e4b4280a apps/claudeck
ls apps/claudeck
```
Expected: files include `cli.js`, `server.js`, `db.js`, `package.json`, `LICENSE`, `README.md`, and dirs `server/ public/ plugins/ config/ db/`.

- [ ] **Step 3: Verify the vendored identity (upstream, not the fork)**

Run:
```bash
grep '"@anthropic-ai/claude-code"' apps/claudeck/package.json && echo "UPSTREAM OK"
test -f apps/claudeck/LICENSE && head -1 apps/claudeck/LICENSE
```
Expected: prints the dependency line + `UPSTREAM OK`, and the LICENSE first line (MIT).

- [ ] **Step 4: Write provenance file**

Create `apps/claudeck/VENDORED.md`:
```markdown
# Vendored from upstream

This directory is a snapshot copy of the upstream **claudeck** project,
vendored under its MIT license (see `LICENSE`).

- **Source:** https://github.com/hamedafarag/claudeck
- **Commit:** bb0fd54db457ccf10de97c8407102e54e4b4280a
- **Vendored:** 2026-07-24
- **Method:** `npx degit hamedafarag/claudeck#<commit> apps/claudeck`

## Local modifications
- Added this `VENDORED.md`.
- (Phase 3 will add a sandbox-management plugin under `plugins/`.)

To update: re-run degit at a newer commit into a scratch dir and diff, or
merge from the `claudeck-upstream` remote if configured.
```

- [ ] **Step 5: Commit the vendored snapshot**

Run:
```bash
git add -A
git commit -m "feat(claudeck): vendor upstream claudeck (MIT) at bb0fd54, replacing the minimal fork

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds.

- [ ] **Step 6: Verify LICENSE + provenance retained**

Run:
```bash
test -f apps/claudeck/LICENSE && test -f apps/claudeck/VENDORED.md && echo "PROVENANCE OK"
```
Expected: `PROVENANCE OK`.

---

### Task 3: Install dependencies, build the native module, and boot the server

**Files:**
- Modify: `package-lock.json` (root — new workspace deps resolved)

**Interfaces:**
- Consumes: the vendored `apps/claudeck/package.json` from Task 2.
- Produces: a running claudeck HTTP server on `http://localhost:9009` serving its UI.

- [ ] **Step 1: Install workspace dependencies from the repo root**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
npm install
```
Expected: completes without error. (If `better-sqlite3` fails to find a prebuilt binary, install Xcode Command Line Tools — `xcode-select --install` — and re-run.)

- [ ] **Step 2: Verify the native module loads**

Run:
```bash
node -e "require('/Users/jayboyer/workspace/sandbox/apps/claudeck/node_modules/better-sqlite3'); console.log('sqlite ok')" \
  || node -e "require('better-sqlite3'); console.log('sqlite ok (hoisted)')"
```
Expected: prints `sqlite ok` (or `sqlite ok (hoisted)`), confirming the native module built.

- [ ] **Step 3: Verify the Turbo build still passes (claudeck is skipped)**

Run:
```bash
npm run build
```
Expected: Turbo runs `build` only in packages that define it (e.g. `sandbox-driver`); `claudeck` has no `build` script and is skipped. Overall exit 0.

- [ ] **Step 4: Confirm no API key is set (subscription billing path)**

Run:
```bash
echo "ANTHROPIC_API_KEY=[${ANTHROPIC_API_KEY:-UNSET}]"
```
Expected: `[UNSET]`. If it prints a value, the launching shell must `unset ANTHROPIC_API_KEY` before Step 5 so the SDK uses the subscription.

- [ ] **Step 5: Launch claudeck on port 9009 (no auth, local)**

Run (in a dedicated terminal; `cli.js` writes `PORT=9009` to `~/.claudeck/.env` and imports `server.js`):
```bash
cd /Users/jayboyer/workspace/sandbox/apps/claudeck
node cli.js --port 9009 --no-auth
```
Expected: logs a startup line and the URL `http://localhost:9009`.

- [ ] **Step 6: Smoke-test the UI over HTTP**

Run (in another terminal):
```bash
curl -s http://localhost:9009/ | grep -io "<title>[^<]*</title>"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9009/api/version
```
Expected: a `<title>` containing claudeck, and HTTP `200` from `/api/version`. Then stop the server (Ctrl-C) or leave it running for Task 4.

- [ ] **Step 7: Commit the lockfile change**

Run:
```bash
cd /Users/jayboyer/workspace/sandbox
git add package-lock.json
git commit -m "chore(claudeck): resolve vendored claudeck workspace dependencies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds. (`~/.claudeck/` is outside the repo — nothing to commit there.)

---

### Task 4: Acceptance — chat rooted in a test project + subscription billing (MANUAL)

This task is **interactive/manual** — it drives a real Claude turn and inspects billing. There is no automated test; the deliverable is confirmed behavior. Do not skip: the billing check is the whole reason the SDK path was scrutinized.

**Files:** none (verification only).

**Interfaces:**
- Consumes: the running server from Task 3.

- [ ] **Step 1: Create a throwaway test project directory**

Run:
```bash
mkdir -p /tmp/claudeck-testproj && cd /tmp/claudeck-testproj && git init -q && echo "# test" > README.md
```
Expected: an empty git repo at `/tmp/claudeck-testproj`.

- [ ] **Step 2: Register it as a claudeck project**

In the claudeck UI (`http://localhost:9009`), open the **Repos Manager** and add `/tmp/claudeck-testproj` as a repo/project. (Equivalently, add it to `~/.claudeck/config/repos.json` and reload.)
Expected: the project appears and is selectable.

- [ ] **Step 3: Confirm the chat is rooted at the project directory**

Select the test project, then in chat send:
```
Run `pwd` and show me the output.
```
Expected: the response reports `/tmp/claudeck-testproj` (or an equivalent cwd), confirming chat is rooted at the selected project's root.

- [ ] **Step 4: Verify subscription billing (not API credits)**

While/after the turn runs, in a separate terminal on the same machine run an interactive Claude and check usage:
```bash
claude
# then inside: /usage
```
Expected: the recent turn's consumption is reflected in the **subscription** usage/limits view, and the Anthropic Console API usage does **not** show a corresponding per-token API charge. If API usage appears, `ANTHROPIC_API_KEY` was set in claudeck's environment — unset it and repeat from Task 3 Step 5.

- [ ] **Step 5: Record the acceptance result**

Append to `apps/claudeck/VENDORED.md` under a new `## Phase 1 acceptance` heading: date, that chat worked rooted in the test project, and that billing was confirmed against the subscription. Commit:
```bash
cd /Users/jayboyer/workspace/sandbox
git add apps/claudeck/VENDORED.md
git commit -m "docs(claudeck): record Phase 1 acceptance (chat + subscription billing verified)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: commit succeeds. Phase 1 complete.

---

## Self-review

**Spec coverage:**
- Vendoring mechanism & provenance → Task 2 (degit + `VENDORED.md`, LICENSE retained). ✓
- Monorepo integration (package as-is, no build, native-dep risk) → Task 3 (install, sqlite check, Turbo skip). ✓
- State/config/port (global `~/.claudeck`, 9009, no auth, loopback) → Task 3 Step 5. ✓
- Billing config + `/usage` verification → Task 3 Step 4 + Task 4 Step 4. ✓
- Remove fork (recoverable) → Task 1 (commit first — corrects the spec's "in history" assumption) + Task 2 Step 1. ✓
- Keep `sandbox-driver`, don't touch `sandbox-dashboard` → Global Constraints; no task modifies them. ✓
- Acceptance criteria (launch, chat rooted, billing, provenance) → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every step has exact commands and expected output. Task 4 is explicitly manual (documented as such, not a hidden gap). ✓

**Type consistency:** No code/types introduced (vendoring). Command/path names consistent across tasks (`apps/claudeck`, port 9009, commit SHA `bb0fd54…`). ✓
