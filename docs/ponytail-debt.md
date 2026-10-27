# Ponytail debt ledger

Every deliberate shortcut in this tree carries a `ponytail:` comment naming its ceiling
and the trigger to revisit. This file is the harvested list, so a deferral can't quietly
become permanent.

**Scanned 2026-08-27 — 26 markers, 6 with no trigger.**

Regenerate the raw list with:

```bash
grep -rn 'ponytail:' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.next --exclude-dir=coverage
```

Grep the **bare string**, not `(#|//) ?ponytail:` as the `ponytail-debt` skill suggests —
over half the markers here are JSDoc-style ` * ponytail:` and the prefixed pattern misses
every one of them. The bare grep also picks up a few prose mentions in
`docs/jit-context-system.md` that are *about* the convention rather than markers;
those are not debt and are excluded below.

A row tagged **no-trigger** names a ceiling but nothing that would prompt revisiting it.
Those are the ones that rot — they are listed first.

## No trigger — decide or delete

| Location | Simplification | Ceiling |
|---|---|---|
| [tree.ts:98](../packages/werkmeister-vscode/src/tree.ts#L98) | skip an overlapping poll rather than queueing | one fewer refresh when `docker ps` is slow |
| [locks.ts:73](../packages/werkmeister-core/src/locks.ts#L73) | read-then-unlink when stealing a stale lock | narrow race against another stealer; only one wins, "good enough for a dev CLI" |
| [gate.ts:32](../packages/werkmeister-core/src/gate.ts#L32) | precedence sentence duplicated from `notes.ts`, not imported | must stay import-light for the <200ms fast path; the two wordings drift by hand |
| [gate.ts:362](../packages/werkmeister-core/src/gate.ts#L362) | unwritable state dir → allow, not deny | a persistence failure silently stops gating instead of failing loudly |
| [workspace_init.ts:352](../packages/werkmeister-core/src/workspace_init.ts#L352) | `mkdir -p` on a dir the caller already checked | none stated — the marker records intent, not a limit |
| [infra.ts:69](../packages/werkmeister-core/src/infra.ts#L69) | corp CA extracted via macOS `security` only | Linux/WSL devs must drop the cert at `~/.werkmeister/corp-ca.crt` by hand |

Three rows left this section rather than sitting in it unresolved. `chat-panel.ts` and
`workspace-ui.ts` were invariants wearing a `ponytail:` prefix — "no React/JSX here" is a
constraint to preserve, not a shortcut to upgrade, and a marker that can never be paid off
teaches readers to skim the prefix. Both keep the reasoning as plain comments and are no
longer markers. `w9r-implement/SKILL.md` is genuine debt and moved down to a named trigger.

## Ripe now

None. Two rows were paid since the last scan.

`terminal.ts`'s one-terminal-per-invocation row: the extension now reuses a terminal once
`onDidEndTerminalShellExecution` reports the previous command finished, and its engine floor
moved to VS Code 1.93.

`shared-infra.yml`'s hand-mirrored `nc -z localhost 9050 && 9051` healthcheck: the trigger
was "generate it like ports/aliases", but the ceiling it also carried — a stale
`kubectl port-forward` accepts TCP and never replies, so `nc -z` passed while Redis was dead
— had been paid for in debugging sessions twice. Both are gone at once:
[probe.sh](../apps/cli/infra/compose/k8s-port-forward/probe.sh) reads the *generated* forward
table, so nothing is mirrored, and each forward gets the probe its `health_endpoint` names
(`redis-cli ping`, `pg_isready`, HTTP GET, or a bare connect). The entrypoint's 45s monitor
calls the same file, so a dead forward is now restarted rather than merely reported.

## Waiting on a named trigger

| Location | Simplification | Ceiling | Upgrade trigger |
|---|---|---|---|
| [worktrees.ts:245](../packages/werkmeister-core/src/worktrees.ts#L245) | "has edits" = working-tree dirtiness only | a worktree whose sole divergence is **committed but unpushed** counts as safe to remove (the branch survives, so nothing is truly lost) | losing committed-but-unpushed work becomes a real risk → check ahead/behind |
| [generate.ts:793](../packages/werkmeister-core/src/generate.ts#L793) | programmatic compose fallback emits `depends_on` but never renders the setup container | a `setup_service:` config only generates correctly through the template | the fallback path becomes reachable |
| [docker.ts:116](../packages/werkmeister-core/src/docker.ts#L116) | unix and tcp endpoints only | an `ssh://` context needs dockerode's ssh2 transport, which the VS Code single-file bundle can't carry | a machine actually runs an `ssh://` context |
| [cache.ts:17](../packages/werkmeister-core/src/cache.ts#L17) | whole-file read-modify-write | separate processes race; last atomic rename wins (worst case re-fetches one key) | entries reach the thousands → SQLite |
| [locks.ts:21](../packages/werkmeister-core/src/locks.ts#L21) | O_EXCL PID-stamped lock file (Node has no `fcntl.flock`) | a crashed holder leaves the file behind; compensated by probing the recorded PID | the PID probe proves insufficient → real flock binding |
| [sandbox.ts:1816](../packages/werkmeister-core/src/sandbox.ts#L1816) | no concurrency cap on the `gh` fan-out | unbounded parallel `gh` calls | workspace × repo count grows large |
| [sandbox.ts:2133](../packages/werkmeister-core/src/sandbox.ts#L2133) | no concurrency cap on the fan-out (matches the row above) | bounded in practice by my-open-PRs + the approval queue | either grows large |
| [SKILL.md:64](../apps/cli/infra/skills/w9r-implement/SKILL.md#L64) | the redirect-verbose-output rule is stated once, at phase entry | drifts into low-attention context by mid-session, which is exactly when a session starts dumping full test output | the edit gate ([gate.ts](../packages/werkmeister-core/src/gate.ts)) already intercepts governed edits — extend it to re-inject on Bash once a session is seen drifting |
| [standards.ts:247](../packages/werkmeister-core/src/standards.ts#L247) | fnmatch leaves `/` literal | repo-root files under-match a `**/*.service.ts` glob; worst case one standard not re-injected | root-level matching ever matters → real glob matcher |
| [generate.ts:240](../packages/werkmeister-core/src/generate.ts#L240) | non-enumerable `Array.prototype.append` patch for Nunjucks `{% do %}` | global prototype patch | it collides with another `append` → template preprocessor |
| [caddy.ts:47](../packages/werkmeister-core/src/caddy.ts#L47) | regex-level brace stripping | assumes placeholders hold no whitespace and don't nest | that stops holding → a real tokenizer |
| [intercept.ts:113](../apps/cli/src/commands/intercept.ts#L113) | no long-running supervision of an intercept | lives in the telepresence daemon until `--leave`/`werkmeister down` | dangling intercepts become a real problem → `--watch` |
| [commands.ts:249](../packages/werkmeister-vscode/src/commands.ts#L249) | fire-and-forget launch | a failure after spawn is invisible | it ever matters → status check |
| [build-tree.ts:100](../packages/werkmeister-vscode/src/build-tree.ts#L100) | strip the `werkmeister-` prefix instead of reading `workspace.yml` per workspace | breaks if a hand-edited `.env` violates the convention | that happens → read the yml |
| [session-stream.ts:13](../apps/werkmeister-dashboard/src/lib/session-stream.ts#L13) | re-read and re-parse the whole transcript on every change | same cost the 3s poller already paid, but push-triggered | large transcripts measurably lag → byte-offset tailing |

## Keeping this current

Nothing regenerates this file. Re-run the grep when the count looks stale and update the
scan date above. Line numbers drift — the paths and the marker text are the durable part,
so grep for the string rather than trusting a number.
