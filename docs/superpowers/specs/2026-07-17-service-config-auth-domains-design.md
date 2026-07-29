# Pain-driven standards domains: `service` merge + `config`, `auth`, `testing`, `observability`

> **Status:** Design / spec. Approved in brainstorming 2026-07-17.
> Next step: `writing-plans` → implementation plan.

## Problem

The JIT standards system has six domains (`ui`, `graphql`, `api`, `data`,
`comments`, `repos`). Every one of them is **single-service, single-file-type**:
it judges code *inside* one box, matched by a file-path glob (`**/*.tsx`,
`**/controllers/**`). But this is a *distributed* system — federated graph + N
web apps + NestJS APIs + Mongo/Redis + OTel + Caddy/CF Workers + GKE/Istio
ambient. The most failure-prone code lives in the **seams between services**,
and no domain covers those.

We seed the highest-confidence seams **pain-driven** — each new rule graduates
from a war story already documented in this repo, not from invention:

| Pain (documented / closed) | Lands in |
|---|---|
| GKE forward silently dies: `find_pod`'s `kubectl get pods` has no `--request-timeout`, hangs forever, kills the retry loop (`docs/known-issues.md`, GKE section) | `service` › resilience |
| `{service-name}` placeholder ban, `host.docker.internal` ban, Docker DNS names (`docs/known-issues.md` §Environment Placeholder Syntax) | `config` |
| Auth0 `AUTH0_AUDIENCE` scoped per service, ID-token vs access-token, `COOKIE_DOMAIN` shared-session scope — PROJ-1897 (commit `af53fda18`, closed) | `auth` |

## Loading model (the constraint every decision below respects)

Standards load **only** by `applies_to` file-path glob, matched against the
files a diff touches (`apps/cli/src/lib/claude_md.ts:build_standards_routing_section`,
`apps/cli/src/lib/graduate.ts:match_domains`). `comments` is the sole exception,
hard-coded to "any code edit". There is **no content/keyword trigger**. The
measured 15/15 *preventive* value comes from the CLAUDE.md-table → entry-skill
→ glob-match chain (`jit-standards-loading-spec.md`).

Consequence: a **behavioral** concern with no natural file type (resilience,
contract-evolution, N+1) cannot get a clean glob, so it cannot stand alone — it
must live in a domain whose glob already covers the files where the behavior
appears. See Decision 1.

### Two-tier loading — why folding is cheap

A generated `tr-<domain>-standard` skill bundle has two tiers
(`apps/cli/src/lib/skill_gen.ts:generate_skills`):

| Tier | Content | Loads |
|------|---------|-------|
| `SKILL.md` | frontmatter gate + STANDARD.md body: `## Rules` / `## Don't` one-liners + `## Going deeper` table | **eager** — the moment a matching file is edited/reviewed |
| `references/*.md` | war stories, code examples, deep guidance | **lazy** — separate bundle files, read only when the model follows a "Going deeper" link |

So eager cost = the terse rule bullets, **not** the detail. This is the
progressive-disclosure pattern `writing-skills` teaches, and it's what makes a
multi-subsection domain affordable: push every war story to `references/`, keep
`## Rules` one-liners. The references tier bounds *detail*, not *rule count* —
so the fold is safe **only** if each subsection's rules stay one-liners.

## Decision 1 — `service`: the service-boundary domain (merge + fold)

A REST endpoint, a GraphQL field, an outbound call, a contract change, and an
N+1 are all *the service boundary contract*. Merge `api` + `graphql` and fold
the three cross-cutting behavioral concerns (resilience, contracts,
performance) into one `service` domain. This is the only domain whose glob
reliably covers every place those behaviors appear, so it's the only place they
load reliably.

**Side benefit (fixes an existing gap):** only `api` has the eligible
`## Rules`/`## Don't`/`## Going deeper` shape today; `graphql` is stuck in the
older "What justifies a comment" shape and **cannot be graduated into**
(`graduate.ts:eligible_domains`). The merge pulls GraphQL into the eligible
structure, so resolver-review nits can graduate.

### Cost accepted + mitigation

Eager-load granularity loss: a `*.controller.ts` edit that once loaded only
api's 61 lines now loads the combined rule bullets across five subsections.
Mitigation is the two-tier model above: terse one-liner rules under labeled
`###` subsections; all prose/examples in lazy `references/`. Target eager cost
≈ one screen. `contracts` and `performance` are near-free to fold because their
rules **already exist** (versioning in api; N+1/dataloader in graphql) — folding
is consolidation, not new eager weight. Escape hatch if it measures heavy
later: split a subsection back out — cheap, since references are already
modular.

### `docs/standards/service/STANDARD.md`

```yaml
domain: service
applies_to:
  # REST (from api)
  - "**/controllers/**"
  - "**/handlers/**"
  - "**/routes/**"
  - "**/*.controller.ts"
  - "**/*.service.ts"
  # GraphQL (from graphql)
  - "**/*.graphql"
  - "**/*.gql"
  - "**/resolvers/**"
  - "**/subgraph*/**"
  # client boundary (resilience)
  - "**/clients/**"
  - "**/*.client.ts"
  - "**/gateways/**"
  - "**/*.gateway.ts"
phase: [implement, review]
summary: Service-boundary contract — REST/Nest conventions, GraphQL federation/Relay, cross-service resilience, contract evolution, and query performance.
```

`## Rules`, terse one-liners under five labeled subsections:

- `### REST` — the six existing `api` rules verbatim (resource naming,
  status/error body, pagination envelope, validate-at-boundary, nullability
  contract, versioning). *(the versioning bullet is absorbed by `### Contract
  evolution` below — cross-reference, don't duplicate.)*
- `### GraphQL` — existing `graphql` guidance reshaped from prose to bullets:
  federation `@key` ownership, Relay-connection shape (single shared `PageInfo`,
  non-null edges/pageInfo), opaque cursors, nullability-as-contract, Typesense
  filter sanitization. *(the N+1/dataloader bullet is absorbed by
  `### Performance` below.)*
- `### Cross-service resilience` — NEW, seeded from the GKE war story:
  - **Bound every outbound call** — explicit timeout on every cross-service/
    network call; an unbounded blocking call in a retry/poll loop is a
    silent-death bug, not a slow path.
  - **Retries need a ceiling + backoff** — no naked `while true` retry without
    max attempts and a per-attempt timeout.
  - **Degrade, don't hang** — a down dependency returns a bounded error; never
    block the request/loop indefinitely.
- `### Contract evolution` — consolidates REST versioning + GraphQL `@key`:
  - **Additive by default** — prefer additive changes to a published contract
    (REST endpoint, GraphQL field/type, federation key).
  - **Breaking change is measured, not silent** — log a deprecation on the old
    path to measure real usage before removing; never silently break callers.
- `### Performance` — consolidates GraphQL N+1 + adds caching:
  - **Batch fan-out** — dataloader-batch resolver fan-out; *deliberate*
    non-batching only where fan-out is bounded (and say so).
  - **Cache reads with a freshness contract** — stale-while-revalidate for
    tolerant reads (the Jira cache pattern); name the TTL/staleness window; never
    cache without an invalidation/expiry story.

`## Don't` — merged one-liners, each linking a `references/ap-*.md`:
`ap-leaky-errors.md`, `ap-untyped-boundary.md` (existing) + `ap-unbounded-call.md`
(NEW — *canonical:* GKE `find_pod` `kubectl get pods` with no
`--request-timeout` in `infra/compose/gke-port-forward/entrypoint.sh`).

`## Going deeper` — merged table: api refs (`pagination.md`,
`error-contracts.md`, `ap-leaky-errors.md`, `ap-untyped-boundary.md`) + graphql
refs extracted to `references/relay-pagination.md` + resilience
`ap-unbounded-call.md`. Add a `caching.md` / `timeouts.md` row only when a real
canonical exists — don't invent one.

### Migration surface

1. Create `docs/standards/service/` (merged `STANDARD.md`; move
   `api/references/*`; extract graphql Relay prose → `references/relay-pagination.md`;
   add `references/ap-unbounded-call.md`).
2. Delete `docs/standards/api/` and `docs/standards/graphql/`.
3. `infra/config/services.yaml`: `standards: [api]` (nest-api archetype) and
   `standards: [graphql]` (graphql-subgraph archetype) → `standards: [service]`.
4. Skills regenerate automatically from dir names
   (`skill_gen.skill_name_for` → `sb-service-standard`); no code change.
5. Update tests hardcoding old keys: `apps/cli/src/lib/__tests__/skill_gen.test.ts`,
   `apps/cli/src/lib/__tests__/workspace_skills.test.ts` (assert `sb-service-standard`; drop
   `sb-api-standard`/`sb-graphql-standard`).
6. Grep for stray `api`/`graphql` domain-key references in docs and any
   `standards_override` in workspace fixtures.

## Decision 2 — new `config` domain (standalone, natural glob)

```yaml
domain: config
applies_to:
  - "**/*.env"
  - "**/*.env.*"
  - "**/config/**"
  - "**/*.config.ts"
  - "**/services.yaml"
  - "**/docker-compose*.yml"
phase: [implement, review]
summary: Config & service wiring — inter-service URL/DNS conventions, env-var rules, no host-relative or templated addresses.
```

Seed rules (`docs/known-issues.md` §Environment Placeholder Syntax + `CLAUDE.md`
conventions):

- **Inter-service URLs use stable Docker DNS names** (`http://web-v2:3060`),
  never `host.docker.internal` from inside a container.
- **No `{service-name}` placeholder syntax** in new env vars — use the DNS alias
  directly (`references/ap-placeholder-env.md`, canonical from the known-issues
  entry).
- **GKE forward ports are container-internal** (`http://gke-forwards:<port>`),
  never exposed to the host.

## Decision 3 — new `auth` domain (standalone; refined from closed PROJ-1897)

```yaml
domain: auth
applies_to:
  - "**/auth/**"
  - "**/*.guard.ts"
  - "**/*.strategy.ts"
  - "**/middleware/**"
phase: [implement, review]
summary: Auth boundary — Auth0 audience scoping per service, ID-token vs access-token, shared-session cookie scope, per-service (not global) auth config.
```

Seed rules (commit `af53fda18`, closed):

- **Audience names an API registered on the target tenant** — a shared/global
  `AUTH0_AUDIENCE` default is a landmine; the global default pointed at the prod
  buyer API, but sandboxes hit the dev tenant with no such API → Auth0
  `access_denied "Service not found"`.
- **Request an audience only when you need an access token** — a service that
  builds its session from the ID token (sb-web) must set no audience; requesting
  one is both wrong-tenant and unnecessary.
- **Scope shared-session cookies to the common parent domain** — `COOKIE_DOMAIN`
  unset scopes the cookie to the emitting host, so a downstream admin gate
  (web-v2) never sees the upstream (web-v1) session.
- **Per-service auth config lives at the service level, never the global** — put
  it in `services.yaml` per service, not `env.j2`, because siblings read the
  same var with their own audiences.

> **Config intersection:** PROJ-1897's pain was in config files
> (`services.yaml` env), which the `config` domain globs. `auth` owns the
> auth-*semantic* rules; `config` owns the wiring mechanics. Cross-link the two
> STANDARD.md files so an auth env-var change surfaces both.

## Decision 4 — new `testing` domain (standalone, natural glob)

```yaml
domain: testing
applies_to:
  - "**/*.spec.ts"
  - "**/*.test.ts"
  - "**/e2e/**"
  - "**/__tests__/**"
  - "**/*_test.ts"
phase: [implement, review]
summary: Test boundaries in a distributed system — unit vs integration vs contract tests, what to mock at a service seam.
```

Seed rules (architecture-derived — flagged low-confidence until real nits
graduate; see Out of scope):

- **Test at the right seam** — unit-test pure logic; integration-test a service
  against its real dependencies via the sandbox; don't mock the thing under
  test.
- **Contract over end-to-end for cross-service** — assert the boundary
  contract (schema/DTO shape) rather than a brittle full-stack path where a
  focused contract test suffices.

## Decision 5 — new `observability` domain (standalone; cross-cutting caveat)

```yaml
domain: observability
applies_to:
  - "**/instrumentation/**"
  - "**/telemetry/**"
  - "**/*.otel.*"
  - "**/logging/**"
  - "**/*.logger.ts"
phase: [implement, review]
summary: Telemetry — OTel span/attribute conventions, structured logging, trace/correlation-ID propagation across service hops.
```

Seed rules (architecture-derived; `otel-init` + `logging-service` exist):

- **Propagate trace context across every hop** — an outbound call forwards trace
  context so a request is one trace end-to-end, not orphaned spans.
- **Log structured, not string-interpolated** — key/value fields, never a
  formatted sentence that can't be queried.

> **Cross-cutting caveat:** spans/logs appear anywhere in business logic, but the
> glob covers only the instrumentation/logging *surface* (setup + logger
> definitions). It will not fire on an ad-hoc span buried in a handler. Accepted
> — a `comments`-style universal load is too heavy; the conventions bite hardest
> where instrumentation is defined.

## Graduation eligibility

All new domains ship with the `## Rules` / `## Don't` / `## Going deeper` shape,
so `graduate.ts:eligible_domains` accepts them and future review nits can
graduate into any of them. `sandbox skills check` must pass with zero
`TODO(graduate)` / `canonical: TODO` markers before commit.

## Confidence tiers (be honest about seed strength)

- **Closed war story, high confidence:** `service` › resilience, `config`,
  `auth`. Ship the seeds as written.
- **Architecture-derived, lower confidence:** `service` › contracts &
  performance (rules pre-exist, so safe), `testing`, `observability`. Their
  strongest rules will come from real product-repo review nits. Ship a *thin*
  seed (2 rules max) and let the authoring loop fatten them; do not invent depth.

## Out of scope (deferred)

- **Content/keyword loading trigger** (`loads_on_content: fetch(|axios|...`) —
  rejected. Real change to the 15/15-measured loading mechanism; the `service`
  fold solves cross-cutting loading without it.
- **A standalone `caching` domain** — considered and rejected; caching folds
  into `service` › Performance (the two-tier model keeps it cheap).
- **PR-comment / incident capture** as note sources — unchanged from
  `jit-content-HANDOFF.md`; still `decision`-notes only.

## Verification

- `sandbox skills check` passes (no leftover TODO/placeholder markers; every
  `## Don't` one-liner links a real `references/ap-*.md`; every `Going deeper`
  row links a real file).
- `apps/cli/src/lib/__tests__/skill_gen.test.ts` + `apps/cli/src/lib/__tests__/workspace_skills.test.ts` updated
  and green.
- Full `cli/tests/` suite green.
- Spot-check: init a throwaway workspace with a nest-api + graphql-subgraph repo
  and confirm the `Standards routing` table shows `service` (union globs) plus
  `config`/`auth`/`testing`/`observability`, and no longer shows `api`/`graphql`.
