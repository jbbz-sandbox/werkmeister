# Plan: Consolidate the GKE forward table onto services.yaml

**Date:** 2026-07-19
**Status:** Tier 1 **and** Tier 2 implemented.

**Tier 1** — made `services.yaml` the single *data* source for the GKE
port-forward table; deleted the two redundant data copies (`gke-forwards.yaml`,
`ports.yaml gke_forwards:`); guarded the two hand-maintained container files
with a drift test.

**Tier 2** (see "Tier 2 — implemented" below) — the two container files are now
*generated* from `services.yaml` by `sandbox connect`, so `services.yaml` is the
sole place to edit. The generated forward rows are set-identical to the original
`FORWARDS` array, so live-tunnel behavior is unchanged.

---

## Problem

The GKE forward table (one row per forwarded service: listen-port, remote-port,
namespace, pod-prefix, health-endpoint) is currently restated in **five**
places:

| # | Location | Fields it holds | Who reads it |
|---|----------|-----------------|--------------|
| 1 | `infra/config/services.yaml` (per service) | `gke_port` (remote), `gke_namespace`, `gke_pod_prefix`, `gke_deployment`, `health_endpoint` | master registry |
| 2 | `infra/config/ports.yaml` → `gke_forwards:` | service → **listen-port** (9000-range) | 3 TypeScript sites (below) |
| 3 | `infra/config/gke-forwards.yaml` | full defs (local/remote/ns/prefix/health) | **only** the dashboard (`sandbox.ts`) |
| 4 | `infra/compose/gke-port-forward/entrypoint.sh` → `FORWARDS=(…)` | full defs, pipe-delimited | the container (runtime source of truth) |
| 5 | `infra/compose/shared-infra.yml` | `ports:` publication + network `aliases:` | Docker Compose (static) |

Drift is already real: `gke-forwards.yaml` (#3) is missing `web-v1` (9009),
`web-v2` (9010), and `vendor-portal-client` (9013), so the dashboard's health
panel silently checks 3 fewer forwards than the container actually runs.

### Key finding — the TypeScript "fallback" is wrong-by-construction

The 3 TypeScript readers do: *look up `ports.yaml gke_forwards[svc]` first, else
fall back to `services.yaml gke_port`.* But those are **different numbers**:

- `ports.yaml gke_forwards[svc]` = the **listen-port** on the `gke-forwards`
  container (e.g. `category-api` → 9002).
- `services.yaml gke_port` = the **remote pod port** inside GKE (e.g.
  `category-api` → 3001).

The resolved value is used to build `gke-forwards:{port}` URLs, which must use
the **listen-port**. The fallback to `gke_port` (3000-range) would emit an
unpublished port like `gke-forwards:3001` — it is never correct for any real
service. It only "works" because every service is present in
`ports.yaml gke_forwards`, so the branch never fires. Net effect:
**`ports.yaml gke_forwards` is load-bearing; the `gke_port` fallback is dead and
misleading**, and `services.yaml gke_port` (remote port) is read by TypeScript only
through that dead branch.

### The lucky break — the target field already exists

`services.yaml` already carries `gke_forward_port:` for one entry:

```yaml
infrastructure:
  mongodb:
    gke_forward_port: 9052
    internal_port: 27017
```

So the consolidation is *extending an existing convention*, not inventing one.

---

## Target state

- **`services.yaml`** is the sole data source. Each forwarded service gains
  `gke_forward_port:` (the 9000-range listen-port), mirroring `mongodb`.
  `gke_port` keeps its correct meaning (remote pod port).
- **Deleted:** `gke-forwards.yaml` (whole file) and the `gke_forwards:` block in
  `ports.yaml` (keep `feature_slots:` — that data is unique).
- **TypeScript readers** read `services.yaml gke_forward_port`; the bogus
  `gke_port` fallback is removed (replaced by a loud error if a non-local
  service lacks `gke_forward_port`).
- **Dashboard** reads `services.yaml` (`gke_forward_port` + `health_endpoint`)
  instead of `gke-forwards.yaml`.
- **`entrypoint.sh` `FORWARDS` and `shared-infra.yml` `ports:`/`aliases:`** stay
  hand-maintained, but a **new test** fails if they drift from `services.yaml`.
  Adding a service is then: edit `services.yaml` + those two container files,
  and the test tells you if you missed one.

---

## Tasks

### 1. Schema: add `gke_forward_port` to `services.yaml`

For every service that has a `gke-forwards` entry today, add
`gke_forward_port:` with the value currently in `ports.yaml gke_forwards`:

| service (services.yaml key) | gke_forward_port | forward name (if ≠ key) |
|---|---|---|
| web-v0 | 9000 | |
| web-v1 | 9009 | |
| web-v2 | 9010 | |
| sb-web-api | 9001 | |
| category-api | 9002 | |
| product-api | 9003 | |
| taxonomy-api | 9005 | |
| interview-api | 9006 | |
| federated-graph | 9004 | |
| vendor-portal-server | 9007 | |
| **vendor** | 9013 | **vendor-portal-client** |
| sandbox-mcp | 9008 | |
| award-api | 9011 | |
| user-api | 9012 | |
| (storybook) | — | no forward (`gke_deployment: null`) — leave unset |
| mongodb (infrastructure) | 9052 | already present |

**Decision — forward-name mismatch:** the service keyed `vendor` maps to forward
`vendor-portal-client`. Add an optional `gke_forward_name:` field **only** on
`vendor` (defaults to the service key everywhere else). This is the one
exception; do not do a blanket rename. Verify during execution whether the
`gke-<name>` network aliases in `shared-infra.yml` are actually referenced
anywhere — if not, the forward name only matters for entrypoint log labels and
the drift test.

**Stale infra entries:** `ports.yaml gke_forwards` also lists `redis: 9050` and
`cloud-sql-proxy: 9051`, which run **locally** (not GKE-forwarded) and appear in
neither `gke-forwards.yaml` nor `entrypoint.sh`. They are stale. Confirm nothing
reads `gke_forwards["redis"]` / `["cloud-sql-proxy"]` (grep), then drop them with
the rest of the block — do **not** migrate them into `services.yaml`.

### 2. TypeScript: read `gke_forward_port`, drop the fallback

Three reader sites resolve the forward port. Point them at the new field and
remove the misleading `gke_port` fallback:

- `apps/cli/src/lib/generate.ts:134` `_gke_port_for_service()` — the shared helper.
  Rewrite to read `services_config[svc]["gke_forward_port"]`; raise (or return
  `None` → existing callers already raise) when a non-local service lacks it.
  Drop the `ports_config["gke_forwards"]` lookup and the `gke_port` fallback.
  Its ~10 callers in `generate.ts` are unaffected (same signature/return).
  Consider dropping the now-unused `ports_config` parameter — but that ripples
  through ~10 call sites; keeping the param and ignoring it is the smaller diff.
- `apps/cli/src/lib/claude_md.ts:301` `gke_port()` inner fn — same rewrite.
- `apps/cli/src/commands/services.ts:34,58-60` — read `svc_def["gke_forward_port"]`
  instead of `gke_ports.get(svc_name)` with `gke_port` fallback.

Update the error message at `generate.ts:190-192` (drop the "ports.yaml
gke_forwards" half; it now reads "service X is not local and has no
gke_forward_port in services.yaml").

### 3. Dashboard: read `services.yaml` instead of `gke-forwards.yaml`

In `apps/sandbox-dashboard/lib/sandbox.ts` (`getGkeForwardsHealth`,
`parseGkeForwards`, ~lines 2695-2806):

- Change `findRepoFile(...)` target from `infra/config/gke-forwards.yaml` to
  `infra/config/services.yaml`.
- Rewrite `parseGkeForwards` to walk the `services:` map (and the
  `infrastructure:` map, for `mongodb`), emitting `{name, port, healthEndpoint}`
  from `gke_forward_port` + `health_endpoint`, skipping services without
  `gke_forward_port`. Use `gke_forward_name` when present.
  - Prefer a real YAML parse if a dependency is already available; the existing
    hand-rolled line parser is acceptable if not — but it must handle the
    nested `services:`/`infrastructure:` structure, not the flat `forwards:`
    block. Check `package.json` for `yaml`/`js-yaml` first.
- mongodb has no `health_endpoint` → falls through to the TCP check, matching
  today's behavior. **This also fixes the drift bug** — web-v1/web-v2/vendor
  will now appear in the health panel.
- Update comments at 2699-2702 and the mock/fixture in `server.ts:1000`.

### 4. Delete the redundant copies

- `rm infra/config/gke-forwards.yaml`.
- Remove the `gke_forwards:` block from `ports.yaml` (keep the
  `feature_slots:` block and the header comment for it).

### 5. Add the drift test (the guard that makes Tier 1 safe)

New test (TypeScript, alongside `cli/tests/`) that parses all three and asserts they
agree, so a hand-edit to one container file without the others fails CI:

- Source of truth: `services.yaml` forwarded services (those with
  `gke_forward_port`) + `infrastructure.mongodb`.
- Assert against `entrypoint.sh` `FORWARDS=(…)`: parse the pipe-delimited array
  (`name|listen_port|remote_port|namespace|pod_prefix|health_path`) and check,
  per forward: `listen_port == gke_forward_port`, `remote_port == gke_port`,
  `namespace == gke_namespace`, `pod_prefix == gke_pod_prefix` (empty ⇢ null),
  `health_path == health_endpoint`. Set equality on names (catches
  missing/extra rows).
- Assert against `shared-infra.yml`: every `gke_forward_port` appears in the
  `ports:` list as `"<p>:<p>"`, and (if aliases are load-bearing per Task 1)
  each forward has a `gke-<name>` alias.
- The test reads the files as text/`yaml`; no container required. This is the
  one runnable check the change leaves behind (per the "lazy code needs its
  check" rule) and the mechanism that lets us leave #4/#5 hand-maintained
  without silent drift.

### 6. Docs

Update the file-list references that name `gke-forwards.yaml` as a live config:
`CLAUDE.md:8`, `README.md:221`, `docs/users-guide.md` (43, 920, 1086),
`.planning/codebase/{STACK,STRUCTURE,INTEGRATIONS,ARCHITECTURE}.md`. Leave
historical `.planning/phases/**` records alone (they describe past state).

---

## Verification

- [ ] `npx vitest run -q` in `apps/cli` — all green, incl. the new drift test.
- [ ] `npm --prefix apps/cli run pyright apps/cli/src/lib/generate.ts apps/cli/src/lib/claude_md.ts apps/cli/src/commands/services.ts` — 0 errors.
- [ ] `grep -rn "gke-forwards.yaml\|gke_forwards\b\|load_gke_forwards" apps/ infra/` — only the drift test's entrypoint parse + `feature_routing.ts`'s unrelated `gke:` router flags remain.
- [ ] Dashboard: `cd apps/sandbox-dashboard && npm run build` (or tsc) — clean; `getGkeForwardsHealth()` returns all 15 forwards (was 12), incl. web-v1/web-v2/vendor-portal-client.
- [ ] End-to-end smoke: `sandbox up <feature>` on a service with a remote dep (e.g. web-v2) → generated `.env`/compose still emit `gke-forwards:<9000-range>` URLs identical to before (diff a generated file pre/post).
- [ ] Deliberately break drift (change one `entrypoint.sh` listen_port) → the new test fails. Revert.

## Tier 2 — implemented

Generation of both container files from `services.yaml`, wired into
`sandbox connect` (`apps/cli/src/commands/connect.ts::_ensure_proxy_files`, before
`docker compose up`). New module `apps/cli/src/lib/gke_forwards.ts`:

- `build_forward_rows()` — the `name|listen|remote|ns|prefix|health` rows, from
  `services.yaml` (services with `gke_forward_port`) + `infrastructure.mongodb`.
- `generate_forwards_file()` — writes `gke-port-forward/tmp/forwards` (gitignored,
  mounted at `/tmp/forwards`). `entrypoint.sh` now reads this file into its
  `FORWARDS` array (fail-loud if absent) instead of hardcoding it.
- `render_shared_infra_forwards()` (pure) / `regenerate_shared_infra_forwards()` —
  rewrite the `ports:` and `aliases:` regions of `shared-infra.yml` between
  `# >>> GENERATED … # <<< GENERATED` markers.

Supporting changes: reconciled `gke_pod_prefix` for web-v0/web-v1/web-v2/vendor
to exact runtime values + gave `infrastructure.mongodb` full forward coordinates
(fields read only by the generator); added `config.load_infrastructure()`; added
GENERATED markers + the `/tmp/forwards` mount to `shared-infra.yml` (both lists
reordered to services.yaml order so first regen is a no-op); rewrote the drift
test to assert shared-infra sync (read-only) + the entrypoint reads the file.

**Safety gate:** `build_forward_rows()` is set-identical to the original committed
`FORWARDS` array (verified), so no tunnel behavior changed. Not exercised against
a live container + GKE here — equivalence is by row-set identity, not a live run.

### Still hand-maintained (deliberately)

- `shared-infra.yml`'s gke-forwards **healthcheck** samples a fixed subset of
  ports (`9000, 9002, 9004, 9009, 9052`) — a sampling check, not the full table.
- The `gke-federated-graph:9004` literal in `Caddyfile.j2` / `generate.ts` is a
  separate hardcoded reference, not driven by this table.

## Risks & rollback

- **Risk:** a forward present in the container but missing `gke_forward_port` in
  `services.yaml` would make its `{service}` refs unresolvable (loud error at
  generate time) — caught by the drift test before runtime.
- **Risk:** dashboard YAML parse regression → health panel empty/throws. Mitigated
  by the build check + returning all 15 forwards in verification.
- **Rollback:** the change is data-relocation + a test; `git revert` restores the
  three files. No migration, no state.
