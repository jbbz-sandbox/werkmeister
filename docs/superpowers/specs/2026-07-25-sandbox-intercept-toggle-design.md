# `sandbox intercept` toggle in the claudeck Workspace tab

**Date:** 2026-07-25
**Status:** Design approved
**Scope:** Surface Telepresence interception as a per-service toggle in the `sandbox-workspace` plugin's Services list. Requires extending `sandbox status` with an intercept subview so the CLI stays the single source of interception state; claudeck reads it from there.

---

## Background & goal

`sandbox intercept <feature> -s <service>` reroutes header-scoped k8s dev traffic to a local container (`apps/cli/src/commands/intercept.ts`). Today it's CLI-only: to know whether an intercept is live you run `sandbox intercept --status`, which dumps raw `telepresence status` + `telepresence list` text.

The `sandbox-workspace` claudeck plugin already renders a **Services** list — one row per running container, with a health dot, name, and published ports — refreshed by a 5s poll. That list is the natural home for an intercept toggle, because a row's *existence* already encodes the intercept precondition.

**Goal:** a toggle in each service row that turns interception on and off, and that tells the truth about state it didn't cause.

### Verified facts

- **"When it is up" is free.** `docker compose ps` (`server.js` `/docker`) lists running containers only, so a row existing means that service is up. `sandbox intercept` independently refuses unless the local slot port is listening (`intercept.ts:180-185`). The two preconditions coincide — no extra gating in the UI.
- **Compose service names are services.yaml keys** (`rest-hello`, `next-hello`), so rows join to the registry by name with no mapping table.
- **Not every service is interceptable.** `intercept.ts:107-118` requires `k8s_deployment`, `k8s_namespace`, `k8s_port`, and `k8s_port_name` (the latter an Istio-ambient precondition). Infrastructure entries like `postgres`/`redis` have none.
- **`telepresence list --format json` is structured and fast** — 165ms, returns per-deployment `{name, namespace, workload_resource_type, agent_version, services[]}`. (`--output json` is deprecated in 2.30.1 in favour of `--format`.)
- **`telepresence list -i` filters to intercepts only** — returns `[]` under `--format json` when nothing is intercepted. Any entry in it *is* an active intercept, so no discriminator field has to be inferred from the unfiltered list.
- **Telepresence has no event mechanism.** No `events` command, no `--watch` on `list` or `status` — there is no equivalent of `docker events`. The global `--format json-stream` does emit the snapshot and then hold the connection open (verified: still running after 15s, no exit, no heartbeat), but whether it pushes deltas on change is unverified, and consuming it is rejected below.
- **`sandbox status --json` is 670ms** and scans every feature's compose plus all k8s health probes — too heavy to hang a 5s poll on, and its cost grows with the number of active features.
- **`sandbox status` already has the focused-subview pattern**: `--k8s` routes to `runK8sOnly`, which skips infra and features entirely (`status.ts:296-320`).
- **One intercept per deployment.** The feature identity lives only in the `x-feature` header filter, so two features cannot both intercept `next-hello`.

### Open unknown (resolve first, do not guess)

`list -i` settles *whether* a deployment is intercepted — presence in the list is the answer. It does **not** settle the shape of an active entry, because nothing is currently intercepted and the list is empty. Specifically unobserved: **the field carrying the intercept's `x-feature` header filter**, which is what `intercepted_by` is derived from.

**First implementation step:** start one real intercept against the local OrbStack `next-hello` (feature `test-me`, slot 1, currently up), capture `telepresence list -i --format json`, and save it as the parser fixture. Reversible via `--leave`; `sandbox down` also leaves intercepts automatically.

If that capture shows the header filter is *not* exposed in `list -i`, `intercepted_by` cannot be populated. Fall back to reporting `intercepted: true` with `intercepted_by: null`, and have the UI treat unknown ownership as the disabled "intercepted by another feature" state rather than as "yours" — wrong-but-safe beats a toggle that claims an intercept it doesn't own.

---

## Design

### 1. `apps/cli/src/lib/telepresence.ts` — two additions

This module is the declared single seam between the CLI and the interception tool (arg builders pure, execution through an injectable `Runner`), so both additions belong here and follow that shape.

- **`interceptBlocker(svcDef): string | null`** — the interceptability predicate, lifted out of `intercept.ts`'s `resolveServiceDef`. Returns a human-readable reason, or null when interceptable. `resolveServiceDef` keeps its `fail()` calls but delegates the *decision* to this function, so "interceptable" has one definition and two callers (`intercept`, `status`) instead of one that can only `process.exit`.
- **`listIntercepts(runner = _run)`** — active intercepts keyed by deployment name, from **`telepresence list -i --format json`**. The `-i` filter means presence *is* the answer; no field-sniffing on the unfiltered list. Returns an empty result when `which("telepresence")` is null, so users without telepresence pay 0ms. Parsing is a separate pure `parseInterceptList(stdout)` so it's testable against the captured fixture, matching how `parseVersion` and `connectedNamespace` are already built.

Each entry carries the deployment's intercept **header filter value** — the feature that owns it — subject to the open unknown above.

### 2. `apps/cli/src/commands/status.ts` — `--intercepts` subview

A focused subview on the `--k8s` precedent: skips infra, docker, and k8s probes; runs only `telepresence list`. Registered in `main.ts` alongside the existing `status` options.

```json
{
  "available": true,
  "connected_namespace": "default",
  "intercepts": [
    {
      "feature": "test-me",
      "service": "next-hello",
      "deployment": "next-hello",
      "interceptable": true,
      "blocker": null,
      "intercepted": true,
      "intercepted_by": "test-me"
    }
  ]
}
```

- Enumerates every active feature's services (from `getAllSlots()`), so it's global like the rest of `status`; consumers filter by feature.
- `available: false` when telepresence is absent or unreadable — degrades to an empty list, never an error.
- `intercepted_by` is required for correctness, not decoration: with one intercept per deployment and the feature carried only in the header filter, a boolean `intercepted` would make feature B's UI show its `next-hello` toggle as ON while feature A owns the intercept.
- The same data folds into the full `sandbox status --json` output as `features[].intercepts`, and into the human text output as a line under a feature only when an intercept is active (silent otherwise — no new noise in the common case).
- Text output for `--intercepts` alone mirrors `printK8sSection`'s table style.

### 3. `apps/claudeck/plugins/sandbox-workspace/server.js`

**Extend `GET /docker`, don't add a status route.** It already takes `project` and returns one row per service. It gains a second subprocess — `sandbox status --intercepts --json` via the existing `resolveSandboxBin` — resolves the workspace's feature via the existing `readFeature(project)`, joins on service name, and each row grows:

```js
{ service, state, health, ports,          // existing
  interceptable, blocker, intercepted, interceptedBy }   // new
```

One fetch, one poll, one client loop. Best-effort throughout: a failed or unavailable intercept lookup leaves the rows intact with `interceptable: false`, never a 500 — the same contract the route already honours for a dead Docker daemon.

**New `POST /intercept` `{ project, service, leave }`.** Deliberately *not* an extension of `/action`: that route's allowlist is tight precisely because `action` selects the command, and threading `-s <service>` through it would loosen that for no gain. Runs `sandbox intercept -s <service>` (plus `--leave`) with `cwd: project`, so the CLI resolves feature and slot from the workspace `.env` exactly as the lifecycle actions do.

- `service` is validated as a non-empty string and passed as an argv element to `spawn`, never interpolated into a shell string. Unknown or non-local services are rejected by the CLI with its existing message (`intercept.ts:94-99`).
- Streams chunked `text/plain` with the terminating `[exit N]` line, identical to `/action`, including the same 10-minute kill timer and abort-kills-child behaviour.

### 4. `apps/claudeck/plugins/sandbox-workspace/client.js`

**Generalize `runAction`** to take a url + body instead of hardcoding `/action` and `{project, action}`. The stream reader, ANSI strip, output pane, toast, and `[exit N]` parse are all reused unchanged — no new machinery for the intercept path.

**Toggle in the existing service-row loop.** Appended after the ports span:

| Row state | Toggle |
|---|---|
| interceptable, not intercepted | enabled — click intercepts |
| intercepted by this feature | enabled + active styling — click leaves |
| intercepted by another feature | disabled, `title="intercepted by <feature>"` |
| not interceptable | disabled + dim, `title=<blocker reason>` |

Disabled-and-explained rather than hidden, so `postgres` having no toggle is answerable by hovering instead of by reading services.yaml.

**Confirmation: on ON only.** Starting an intercept installs a traffic-agent sidecar on a Deployment in a shared dev cluster — a real mutation on infrastructure teammates use, even though the rerouting itself is header-scoped. The confirm names that scope. Leaving needs no confirm; it only restores the baseline. This matches `/action`'s existing asymmetry (confirm on `down`/`stop`, not on `up`).

**Streamed output is a feature, not just progress.** On success the CLI prints the ready-to-use `curl -H 'x-feature: …'` line and the remote hostname (`intercept.ts:207-219`). That lands in the existing `sw-action-output` pane and is the most directly useful part of the change.

**Polling keeps toggles honest for free.** The 5s poll already exists because Docker flips `starting`→`healthy` after `sandbox up` returns; intercept state has the same property. A terminal-side `--leave`, or `sandbox down` silently calling `leaveFeatureIntercepts`, both surface within one tick. No extra wiring.

#### Why polling, not push (decided — don't re-litigate)

Telepresence exposes no event mechanism (see Verified facts). `--format json-stream` stays open and *might* push deltas, but consuming it is rejected on three grounds, in order of weight:

1. **The poll is unavoidable regardless.** It exists for the Docker health dots and runs whether or not intercept state joins it. Intercept state's marginal cost is one 165ms subprocess per tick.
2. **Push would undo the CLI seam.** Consuming `json-stream` means the plugin server holds a long-lived `telepresence` child and parses its output — putting telepresence knowledge back inside claudeck, which is precisely what routing through `sandbox status --intercepts` avoids. The trade is a persistent child process, reconnect-on-death logic, and a second transport to the browser.
3. **The state barely changes.** Intercepts flip a few times an hour. Push earns its complexity on high-frequency state.

Revisit only for a genuinely high-frequency feature — live per-intercept request counts in the UI, say — and verify `json-stream`'s delta behaviour before designing against it.

### 5. `client.css`

Toggle pill styled against the existing `sw-svc-*` rules — off / active / disabled variants, reusing the theme variables already used by the health dots and PR pills.

---

## Data flow

```
5s poll ──▶ GET /docker?project=<ws>
              ├─▶ docker compose ps --format json      (cwd=ws)  ──▶ parseComposePs
              └─▶ sandbox status --intercepts --json              ──▶ telepresence list
                                                                       + interceptBlocker
              join on service name ──▶ rows with intercept fields ──▶ svc rows + toggles

click ─────▶ POST /intercept {project, service, leave}
              └─▶ sandbox intercept [-s svc] [--leave]  (cwd=ws, streamed)
                    └─▶ output pane; refreshServices() on close
```

---

## Error handling

| Failure | Behaviour |
|---|---|
| telepresence absent | `available: false`, all rows `interceptable: false` with a blocker reason; toggles disabled and explained |
| telepresence too old / cluster unreachable | intercept attempt fails; CLI's own message streams into the output pane, toast reports non-zero exit |
| `sandbox status --intercepts` fails or times out | rows keep Docker state, lose intercept fields; toggles disabled. Never a 500 |
| service not interceptable | toggle disabled with the blocker as its tooltip; the command is never issued |
| deployment intercepted by another feature | toggle disabled, tooltip names the owning feature |
| intercepted, owning feature unreadable | toggle disabled, tooltip says ownership unknown — never rendered as "yours" |
| local port not listening | CLI refuses with its existing message; can't normally happen since the row implies running |
| browser aborts the request | child killed, same as `/action` |

---

## Testing

- **`parseInterceptList`** — pure parser, fixture-based unit test from the captured `list -i` output: the empty case (`[]`, verified live), one active intercept (captured in step 1), and malformed input. Follows the existing `parse-*.test.mjs` and CLI test conventions.
- **Unknown ownership** — assert that an intercept with no readable header filter yields `intercepted: true, intercepted_by: null`, and that the UI maps that to the disabled state, not the active one.
- **`interceptBlocker`** — table test over service defs: fully specified, each missing key, missing `k8s_port_name`.
- **`listIntercepts`** — injected `Runner` returning the fixture; asserts the empty result when telepresence is absent.
- **`status --intercepts`** — asserts the JSON contract shape with an injected runner.
- Client-side DOM glue is untested, matching the plugin's existing convention (only the `.mjs` parsers carry tests).

---

## Out of scope

- Multi-service intercepts in one click (workspace-level "intercept all").
- Intercept state for features other than the selected workspace's.
- Telepresence install/upgrade automation — the CLI's `INSTALL_HINT` already covers it.
- `--docker-daemon` mode selection from the UI; the CLI default is used.
