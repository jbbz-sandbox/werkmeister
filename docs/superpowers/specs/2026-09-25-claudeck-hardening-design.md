# Claudeck Hardening — Remaining Audit Items (Design)

**Date:** 2026-09-25
**Scope:** `apps/claudeck`
**Predecessor:** `SECURITY_AUDIT.md` (2026-07-25), items 2, 4, 5, 6, 7, 9, 10

## Context

`SECURITY_AUDIT.md` listed eleven findings. One (#1, the vulnerable
`@anthropic-ai/claude-code` dependency) was resolved before the audit was
revisited — the package is gone, replaced by `@anthropic-ai/claude-agent-sdk`.
Three (#3 database close, #8 cookie `secure`, #11 `PORT` validation) were fixed
on 2026-09-24, together with a hole the audit never listed: `/api/exec` was
reachable by any web page via DNS rebinding, giving unauthenticated RCE on a
stock install. That fix added `hostGuard` in `server/auth.js`.

This document covers what is left, and says explicitly what is not worth doing.

## Trust model

Every scoping decision below follows from this, so it is stated once here.

Claudeck is a single-user tool bound to loopback. Token auth is optional and off
by default. After the `hostGuard` work the boundary is:

- A local, same-origin browser page reaches the API. So does a local non-browser
  client (curl, the CLI).
- Anything arriving under a foreign `Host`, or cross-site, is refused outright
  or must present the token.

Two consequences, both load-bearing:

1. **Actions the user can already perform are not a privilege boundary.**
   `/run <command>` executes arbitrary shell commands *by design*, and the file
   routes read files the user owns. Locking these down protects nothing: the
   person on the other end has a terminal. This is why blanket input-validation
   is a non-goal.

2. **Data the user did *not* type is a different matter.** Branch names, file
   paths and commit messages originate in the *repository*, and a repository can
   be a clone of someone else's code. That data currently reaches a shell.

Point 2 is the one real remaining hole, and it is not a network-attacker
problem. Clone a hostile repo, open the Git tab, and the shell runs whatever the
branch name says.

## Goals

- **G1** No data-derived string reaches a shell. Programmatic commands run via
  `execFile` with an argv array.
- **G2** The shell path still exists for `/run`, but is explicit, greppable, and
  impossible to reach by accident.
- **G3** Auth tokens stop appearing in URLs on the HTTP surface.
- **G4** A genuine database migration failure is loud, not swallowed.
- **G5** Losing the VAPID keys is survivable, or at least announced.

## Non-goals

- **NG1 — Blanket schema validation (audit #7).** 18 route files, a new
  dependency, and per trust-model point 1 it defends nothing: the caller is the
  user. The routes already reject missing fields, and `files.js:50` already has
  a traversal guard. The validation that *does* matter is G1, which this design
  covers properly instead of sprinkling `joi` everywhere.
- **NG2 — TypeScript migration (audit #9).** Weeks of churn on a working local
  app. The rest of the repo is TypeScript; claudeck is a vendored fork and
  diverging it further has a cost of its own.
- **NG3 — ESLint (audit #10).** Reasonable, but a separate ticket. It is a code
  quality want, not a hole, and it will produce a large mechanical diff that
  would bury the security changes here.
- **NG4 — Rate limiting the whole API (audit #6).** Throttling a single-user
  local tool mostly throttles its one user. Only `/api/auth/login` gets a
  limiter, and only so a token cannot be ground down by a local process.
- **NG5 — Sharing `hostGuard` with `sandbox-dashboard`'s `localOnly`.** The two
  are now near-duplicates (`lib/localhost-form.ts:74`). Hoisting the shared rule
  into `sandbox-core` is correct eventually, but claudeck does not depend on
  `sandbox-dashboard` today and this change is not the moment to add a coupling.
  Tracked, not done.

---

## Item A — Shell injection from repository data

**Audit:** not listed. Found 2026-09-24.

**Problem.** `public/js/panels/git-panel.js` builds shell command *strings* by
interpolating branch names, file paths and commit messages inside double quotes,
then posts them to `/api/exec`. Double quotes do not stop `$(...)`, backticks or
`\` in `sh`. The commit path escapes `"` only:

```js
const escaped = msg.replace(/"/g, '\\"');
await execCommand(`git commit -m "${escaped}"`, cwd);   // git-panel.js:266
```

`server/routes/exec.js:28-33` then picks `exec` (a shell) over `execFile`
whenever the string has more than two whitespace-separated parts — which every
one of these commands does.

**Evidence.** Replaying the route's own branch logic:

```
exec (SHELL)   git checkout "main$(echo INJECTED)"
exec (SHELL)   git commit -m "fix$(echo INJECTED)"
shell output:  mainINJECTED
```

Nine call sites interpolate: `git-panel.js` lines 50, 172, 199, 214, 235, 240,
243, 266, 329.

**Second defect, same cause.** The `execFile` branch passes the *quoted* token
as a literal argument, so two-part commands are simply broken:

```
$ cat "README.md"  →  execFile("cat", ['"README.md"'])
cat: "README.md": No such file or directory
```

The file-preview path (`git-panel.js:235`) has been dead for exactly this
reason. One fix repairs both.

**Decision.** Replace the string API with an argv API.

```
POST /api/exec { argv: string[], cwd? }          → execFile, never a shell
POST /api/exec { shellCommand: string, cwd? }    → exec, shell, /run only
```

- `argv` is the only mode the UI uses. No quoting, no splitting, no heuristic.
- `shellCommand` is named so that every call site reads as a deliberate choice
  and `grep shellCommand` finds all of them. The rule is "nothing built from
  data", not "one caller": there are five call sites today. `/run`
  (`registerCommand("run", …)` in `public/js/features/chat.js`) is the only
  one that carries data — the user literally typed the command and pipes are
  the point. The other four pass string constants that still need a shell:
  `"code ."` in `features/projects.js`, `plugins/sandbox-workspace/client.js`,
  and `plugins/repos/client.js` (twice), plus the per-platform terminal
  launcher in `plugins/repos/client.js`. They need `exec`, not `execFile`,
  because `execFile` does no PATHEXT resolution and so cannot launch
  `code.cmd` on Windows, and because the Linux terminal launcher uses `||`.
- The `command` field and the `isSimple` heuristic are **removed**. No silent
  fallback: a stale caller gets a 400, not a shell.

**Path arguments get `--`.** With argv, a file named `-rf` is passed to `git` as
an option. Every git invocation taking paths separates them:
`["git","add","--", ...files]`. `git-panel.js` already does this for `checkout`
and `diff`; `add` and `reset HEAD` do not.

**Rejected alternative.** Keep strings, add a `shellQuote` helper — one exists
twice in this repo (`sandbox.ts:3018`, `terminal.ts:18`). Smaller diff, but it
leaves the whitespace-splitting heuristic in place (so filenames with spaces
stay broken), and it keeps a correct-quoting obligation on every future call
site. argv removes the obligation instead of restating it.

**Breaking change.** Accepted. `private: true`, single user, and every caller is
in this repo: `core/api.js`, `panels/git-panel.js`, `ui/status-bar.js`,
`features/projects.js`, `features/chat.js`. Plugins DO reach `/api/exec` — two
paths: `execCommand`/`execShell` imported directly from `/js/core/api.js`
(`plugins/sandbox-workspace/client.js`), and `ctx.api`, which
`public/js/ui/tab-sdk.js:263` sets to the entire api module, giving every
plugin the same access (`plugins/repos/client.js`). The original check missed
both because it grepped for the literal string `"api/exec"`, which appears
nowhere in a plugin — the plugins call the wrapper functions, not the
endpoint URL. `plugins/sandbox-workspace/client.js` was a second Git panel
carrying the same interpolation as `panels/git-panel.js` and was converted
alongside it.

## Item B — Token accepted in query parameters

**Audit:** #5.

**Problem.** `extractToken` (`server/auth.js:57-60`) falls back to
`?token=` on the HTTP surface. URLs reach server logs, browser history,
`Referer` headers and shoulder-surfers.

**Decision.** Delete the HTTP query-parameter branch. Keep `Authorization:
Bearer` and the cookie.

**The WebSocket keeps its query token.** Browsers cannot set headers on a
WebSocket handshake, so `ws://host/ws?token=` is the only mechanism available to
the page. That path lives in `wsToken()` and is unaffected. This asymmetry is
deliberate and worth the comment it will get.

**Verified safe.** Nothing in `public/` or `cli.js` uses `?token=` for HTTP;
the only references are the WS helper and a CLI flag that sets the env var.

## Item C — No rate limit on token submission

**Audit:** #6, narrowed per NG4.

**Problem.** `POST /api/auth/login` validates a token with no attempt limit.

**Perspective.** The token is 32 random bytes. It is not going to be guessed.
This is defence in depth against a *local* process grinding, and it is ~15 lines.

**Decision.** A fixed-window counter in a `Map`, keyed by remote address: 10
failures per 15 minutes, then 429 until the window rolls. Successful logins do
not count. No dependency — `express-rate-limit` is 3 transitive packages for
something one `Map` does.

**Constraint: never lock the user out of their own machine.** Only *failed*
attempts count, and the window is short.

## Item D — Migration failures are indistinguishable from success

**Audit:** #2 (filed as "SQL injection risk" — it is not; the statements are
hardcoded and take no user input; the real defect is the silent catch).

**Problem.** `db/sqlite.js:63-86` and `147-148` run 21 idempotent
`ALTER TABLE … ADD COLUMN` statements, each wrapped in `catch { /* exists */ }`.
"Column already exists" and "disk is full" are handled identically, so the app
boots with a half-migrated schema and fails later, somewhere else.

**Decision.** One helper, applied to all 21 sites:

```js
function addColumn(db, sql) {
  try { db.exec(sql); }
  catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
```

`db` is a parameter rather than the module-level handle so the helper can be
tested without opening a database.

SQLite's error for a re-added column is `duplicate column name: X`. Anything
else propagates and stops startup, which is the correct outcome for a schema
that did not migrate.

The `CREATE UNIQUE INDEX … IF NOT EXISTS` at line 148 already carries its own
idempotence and needs no catch at all — its `try` goes away.

## Item E — VAPID keys regenerate silently

**Audit:** #4.

**Problem.** `server.js:60-76` generates VAPID keys when absent and appends them
to `~/.claudeck/.env`. If that file is lost or the append fails, new keys are
minted on next boot and every existing push subscription is silently dead —
subscribers get nothing, with no error anywhere.

**Decision.** Proportionate to a single-user tool:

1. Warn loudly on generation, naming the file to back up.
2. If the append *fails*, say so at error level and explain that keys will be
   regenerated (and subscriptions broken) on next start. Currently the throw
   would take down boot with no explanation.
3. When keys are generated but push subscriptions already exist in the database,
   warn that those subscriptions are now orphaned and will be purged.

**Rejected.** Key rotation, a backup subsystem, a keystore. Not for a local
single-user push feature.

---

## Verification

Per item, the check that fails if the fix regresses:

| Item | Check |
|---|---|
| A | `argv` mode never calls `exec`; a branch named `main$(echo X)` reaches `git` as one literal argument |
| A | A path argument beginning with `-` is passed after `--` |
| B | `GET /?token=<valid>` is rejected when auth is on; `Authorization` and cookie still work; WS `?token=` still works |
| C | 11th failed login in a window returns 429; a correct token before the limit still returns 200 |
| D | A non-duplicate-column error propagates out of startup; a duplicate-column error does not |
| E | Generating keys logs a warning; an append failure does not crash unexplained |

Full suite (`npm test` in `apps/claudeck`, 2720 tests as of 2026-09-24) must stay
green. `tests/unit/backend/routes/exec.test.js` is rewritten by Item A — its
tests encode the `isSimple` heuristic being removed.
