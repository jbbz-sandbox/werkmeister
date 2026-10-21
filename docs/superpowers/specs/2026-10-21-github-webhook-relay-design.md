# GitHub webhook relay for PR and release events

status: draft, 2026-10-21

## Why

Werkmeister learns about GitHub changes by polling. A merged PR reaches its
session up to 10 minutes late (`CALLBACK_POLL_MS`, the `pr watch` launchd
job), and a release only flips a PR to `shipped` on that same timer. Two things
are wanted:

1. **Merges show up within seconds**, not minutes.
2. **After a release, the feature is checked for real in production**: the
   published `werkmeister` package installed from npm and the PR's exercise
   checks redone against it, not just "npm lists the version".

## Decided

- **Relay: smee.io.** GitHub's webhook points at a smee channel; werkmeister
  holds an outbound connection to it. No offline queue: events sent while
  nothing is listening are lost, and the existing polls catch up.
- **Host: the dashboard server** (`apps/sandbox-dashboard`). Harness plugins
  (Claude Desktop today; opencode, Cursor, Codex later) are
  harness-specific, so the relay lives in the one process they all share.
  Plugins only listen to the dashboard.
- **Events are a "refresh now" signal, not data.** An event triggers the
  same refresh the timers run today (`watchPrs` / `refreshPrStatus`, the
  plugin's `prTick` and `callbackTick`). No new GitHub-state logic, and the
  PR files stay the only state.
- **Polls stay as the fallback.** The dashboard usually runs as the managed
  background server (`DASHBOARD` in `sandbox-core/src/web_servers.ts`,
  started by `sandbox connect`/`up`), but it can be down and smee drops
  events, so nothing may depend on the relay.
- **Host only.** The relay starts only in the host's dashboard: never in a
  `HOST=0.0.0.0` instance inside a sandbox container, where `watchPrs`
  would reap and resume against the container's view. *(My call.)*
- **PRs that don't ship in the package** (plugins, dashboard, private
  packages): the session says so, skips the release check, and asks about
  close-out as usual.
- **Release check failure:** the session records it and stops. The person
  checks the release by hand and restarts the workspace agent. No automatic
  fix, retry, or close-out.

## How it fits together

```
GitHub webhook ──> smee.io channel ──SSE──> dashboard server
                                              │ 1. verify signature
                                              │ 2. watchPrs({desktop:false})   (terminal sessions)
                                              │ 3. broadcast "github" event
                                              v
                              GET /api/github/events (SSE, loopback)
                                              │
                    ┌─────────────────────────┼──────────────────────┐
             Claude Desktop plugin      future opencode plugin   future …
             → callbackTick + prTick    → its own refresh
```

### Dashboard server

- On start, if a smee URL is configured, open the channel as an event
  stream (plain `fetch` reading `text/event-stream`, or Node's `EventSource`
  if the runtime has it; no new dependency) and reconnect with backoff when
  it drops. No URL configured: do nothing, as today.
- Each smee message carries GitHub's headers and body. Act only on
  `x-github-event` of `pull_request` (action `closed`) and `release`
  (action `published`); ignore the rest.
- **Verify `x-hub-signature-256`** against the configured webhook secret
  before acting. A smee channel is readable and writable by anyone holding
  its URL, so a forged event must not trigger anything. A bad or missing
  signature: log and drop. **Check this first:** smee re-serializes the
  JSON body, which can break an HMAC over the raw bytes. If real deliveries
  fail verification, stop and raise it rather than silently dropping the
  check; the fallback is accepting unverified events, which is tolerable
  only because an event is a debounced refresh signal.
- Debounce: several events for one merge or release collapse into one
  pass (a few seconds is enough).
- Run `watchPrs({ desktop: false })` itself, so terminal (headless) sessions
  get their callback at once. When it finishes, broadcast one SSE message on
  `GET /api/github/events` (loopback only, like `/api/session/stream`), e.g.
  `{ event: "pull_request" | "release", repo, at }`. Broadcasting *after* the
  dashboard's pass keeps it from holding `pr-callbacks.lock` when a plugin's
  pass starts.

### Claude Desktop plugin (`plugins/werkmeister/hooks/register.tsx`)

- Hold a subscription to `/api/github/events` for the plugin's life
  (`$.process.spawn` of a small streaming reader, since `$.http.fetch` only
  resolves after the whole body), retrying quietly while the dashboard is
  down.
- On each message: run `callbackTick` and `prTick`. The 60 s and 10 min
  timers keep running unchanged.
- `plugins/sandbox-tools/hooks/register.tsx` is a byte-identical copy and
  gets the same change.

### Release check (`pr_lifecycle.ts`, `callbackMessage`)

The `shipped` callback message changes from "ask about close-out" to:

> PR {url} shipped in {release}. If nothing this PR changed ships in the
> published package, say so, skip the release check, and ask the person
> whether to run `sandbox close-out`. Otherwise, check it's live: in a fresh temp directory
> (not the repo checkout), install the released version the way a user gets
> it (if it isn't installable yet, wait for it for up to ~10 minutes before
> calling that a FAIL), and redo the checks from this PR's exercise.md against that install.
> Add a "Release check" section to exercise.md with its own PASS/FAIL table;
> mark checks that only make sense in the local sandbox (containers, test
> commands) N/A. All PASS: ask the person whether to run `sandbox close-out`.
> Any FAIL: stop and tell the person. They'll check the release by hand and
> restart this agent.

A repo without `ship: tag` goes merged → shipped with no release; it keeps
today's message (no `release`, no check). *(My call.)*

This message goes to the session that opened the PR, through the existing
callback path, so it works the same whether a webhook or a poll noticed the
release. With no live session, no check runs, as with today's callbacks.

### Setup (one time, per repo)

1. Create a channel at smee.io.
2. Put the channel URL and a generated webhook secret in the werkmeister
   user config (the same file `loadConfig()` reads).
3. Add the repo webhook: payload URL = the smee URL, content type JSON,
   that secret, events = Pull requests + Releases. A `gh api` one-liner in
   the dashboard README is enough; no setup command.

Only `jbbz-sandbox/sandbox` needs it today; nothing in the design is tied
to one repo.

## Goals

- Merge callbacks arrive within seconds when the dashboard is running.
- Every shipped PR whose session is alive and whose change ships in the
  npm package gets a real post-release check against the published
  package, with the result written to exercise.md.

## Non-goals

- An offline queue or replay of missed events.
- Plugins for other harnesses (the dashboard's SSE endpoint is what they'll
  use; building them is separate work).
- Faster CI/check status on the workspace cards beyond triggering `prTick`.
- Making the dashboard a background daemon.

## Anti-goals

- Anything that breaks or slows today's polling when the dashboard, smee,
  or the webhook is missing.
- Webhook payloads being trusted as state, or unsigned events triggering
  work.
- The release check auto-fixing, retrying, or closing out on its own.

## Left to the builder

- Exact config keys for the smee URL and secret.
- Debounce interval and reconnect backoff.
- The SSE message shape beyond "a refresh signal".
- How the Desktop plugin's streaming reader is spawned (curl, a node
  one-liner, ...).
- Tests: signature check and event filtering in the dashboard; the new
  `callbackMessage` text; the plugin reacting to an SSE message.

## Calls I made (not discussed)

- Verify the GitHub signature even though events are only a signal.
- Dashboard runs the headless `watchPrs` pass itself, then broadcasts.
- Only `pull_request` closed and `release` published trigger anything.
- The release check is a generic message, not npm-specific code; the
  session knows how its package is installed.
- Setup is documented, not automated.
- Relay runs in the host dashboard only.
- The release check waits up to ~10 minutes for the version to be
  installable before failing; that's waiting on npm, not a retry.
- Repos without a release tag keep today's shipped message.
