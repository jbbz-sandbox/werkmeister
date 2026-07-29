# Standards domains: service merge + config/auth/testing/observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add distributed-systems standards coverage by merging `api`+`graphql`+resilience/contracts/performance into one `service` domain and adding four new domains (`config`, `auth`, `testing`, `observability`).

**Architecture:** Standards live as `docs/standards/<domain>/STANDARD.md` (+ `references/*.md`). `apps/cli/src/lib/skill_gen.ts` renders each into a `tr-<domain>-standard` skill (SKILL.md eager, references lazy). `services.yaml` archetype `standards:` keys control which are active per workspace. Loading is by `applies_to` file-path glob only.

**Tech Stack:** Node 20+, vitest, uv; Markdown + YAML frontmatter standards docs.

## Global Constraints

- Standards docs are directory-form: `docs/standards/<domain>/STANDARD.md` (+ optional `references/`).
- Skill names derive from dir name: `tr-<domain>-standard` (`skill_gen.skill_name_for`). No code change needed to register a domain — creating the dir is enough.
- `validate_module_references` (run by `sandbox skills check`) requires, for every `references/*.md`: no `TODO(graduate)` marker; `canonical:` ≠ `"TODO"`; the file is linked via `(references/<name>)` somewhere in STANDARD.md; and every `ap-*.md` additionally has an inline `## Don't` bullet matching `^\s*[-*] .*(references/ap-<name>.md)`.
- Graduation eligibility (`graduate.ts:eligible_domains`) = STANDARD.md body contains **both** `## Rules` and `## Don't`. Every new domain must have both.
- `## Rules` bullets stay terse one-liners; all depth goes in lazy `references/`. This is the eager-load budget — do not inline war stories into STANDARD.md.
- Reference frontmatter: `kind: anti-pattern` (file named `ap-<slug>.md`) or `kind: example`, plus `canonical: <repo>:<path>` pointing at real code.
- Run tests with `npx vitest run` from `apps/cli/`.
- **The authoring check** (`validate_module_references`, which gates reference-linking / canonical / TODO rules) is run standalone — `sandbox skills check` also runs it but requires a real workspace and adds workspace-drift noise. Use this exact command from repo root, referred to below as **AUTHORING_CHECK**:
  ```bash
  cd apps/cli && node --input-type=module -e "const {validateModuleReferences} = await import('./dist/lib/skill_gen.js'); const e = validateModuleReferences(); console.log(e.join('\n') || 'authoring OK'); process.exit(e.length ? 1 : 0)"
  ```
  Expected on success: prints `authoring OK`, exit 0.
- Spec: `docs/superpowers/specs/2026-07-17-service-config-auth-domains-design.md`.

---

### Task 1: `service` domain — merge api + graphql + fold resilience/contracts/performance

**Files:**
- Create: `docs/standards/service/STANDARD.md`
- Create: `docs/standards/service/references/pagination.md` (moved from `api/`)
- Create: `docs/standards/service/references/error-contracts.md` (moved from `api/`)
- Create: `docs/standards/service/references/ap-leaky-errors.md` (moved from `api/`)
- Create: `docs/standards/service/references/ap-untyped-boundary.md` (moved from `api/`)
- Create: `docs/standards/service/references/relay-pagination.md` (extracted from `graphql/STANDARD.md`)
- Create: `docs/standards/service/references/ap-unbounded-call.md` (new)
- Delete: `docs/standards/api/` (whole dir), `docs/standards/graphql/` (whole dir)
- Modify: `infra/config/services.yaml:29` and `:33`
- Modify: `apps/cli/src/lib/__tests__/workspace_skills.test.ts` (skill-set assertions)
- Modify: `apps/cli/src/lib/__tests__/skill_gen.test.ts:22` (`test_all_repo_modules_generate_a_skill` domain tuple)

**Interfaces:**
- Produces: domain key `service`, skill `sb-service-standard`, active on the `nest-api` and `graphql-subgraph` archetypes.
- Consumes: nothing (first task).

- [ ] **Step 1: Move the four api reference files unchanged into `service/references/`**

```bash
cd /Users/jayboyer/workspace/sandbox
mkdir -p docs/standards/service/references
git mv docs/standards/api/references/pagination.md      docs/standards/service/references/pagination.md
git mv docs/standards/api/references/error-contracts.md docs/standards/service/references/error-contracts.md
git mv docs/standards/api/references/ap-leaky-errors.md docs/standards/service/references/ap-leaky-errors.md
git mv docs/standards/api/references/ap-untyped-boundary.md docs/standards/service/references/ap-untyped-boundary.md
```

- [ ] **Step 2: Extract the GraphQL Relay/cursor prose into `relay-pagination.md`**

Create `docs/standards/service/references/relay-pagination.md` with the Relay content lifted verbatim from the current `docs/standards/graphql/STANDARD.md` (the `## Relay pagination` section — the `ThingConnection`/`ThingEdge`/`PageInfo` schema block, the args/opaque-cursor bullets, and the "Avoid" note), wrapped as an example reference:

```markdown
---
kind: example
canonical: "econx:apps/web-v2/schema.graphql"
---

# Relay Cursor Connections — the paginated-list shape

## The load-bearing part

Paginated list fields use the Relay Cursor Connections shape — the Relay/Apollo
client cache depends on it, so don't invent a bespoke `{items, nextPage}` shape.

```graphql
type ThingConnection {
  edges: [ThingEdge!]!        # non-null list of non-null edges (empty, never null)
  pageInfo: PageInfo!         # always present
  totalCount: Int             # optional; omit if it forces an extra COUNT query
}

type ThingEdge {
  node: Thing!
  cursor: String!             # opaque; equals PageInfo.startCursor/endCursor at the ends
}

# ONE shared PageInfo across all connections — not a per-type copy.
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

- **Args**: forward = `first: Int, after: String`; backward = `last: Int, before: String`.
  Implement forward at minimum; add backward only when a client needs it.
- **Cursors are opaque** — base64 an encoding of the sort key + a unique tiebreaker
  (e.g. `(createdAt, id)`), never a raw offset or bare DB id. Offsets skip/duplicate
  rows under concurrent writes; the cursor must stay stable across inserts and deletes.

## Going deeper

Avoid (present in web-v2 `schema.graphql`, don't copy): a per-connection
`<Type>PageInfo` — collapse to the single shared `PageInfo`; and nullable
`edges`/`pageInfo` — make both non-null so callers never null-check a list that
is always returnable.
```

- [ ] **Step 3: Create the new resilience anti-pattern reference**

Create `docs/standards/service/references/ap-unbounded-call.md`. Canonical points at the real file where this was mined and fixed (`--request-timeout=10s`):

```markdown
---
kind: anti-pattern
canonical: "sandbox:infra/compose/gke-port-forward/entrypoint.sh"
---

# An outbound call with no timeout, inside a retry loop

## What it looks like

```bash
# find the pod, forever if the API server is slow
find_pod() {
  kubectl get pods -n "$namespace" \
    --field-selector=status.phase=Running \
    -l "$selector" -o jsonpath='{.items[0].metadata.name}'
}
while true; do
  pod=$(find_pod "$ns" "$prefix")   # no timeout — hangs here
  kubectl port-forward "$pod" ...
done
```

## Why it's wrong

Real code: `sandbox:infra/compose/gke-port-forward/entrypoint.sh`.
When a spot GKE node is preempted, a `kubectl` call with no `--request-timeout`
blocks indefinitely against the unreachable API server. The enclosing
`while true` retry subshell never comes back around, so the forward dies
silently — the log file just stops updating. An unbounded blocking call inside
a loop is not a slow path; it is a silent-death bug.

## The fix

Bound every `kubectl` call with `--request-timeout`, so a stuck API server
surfaces as a fast error the loop can retry instead of a hang. The fixed code
(`entrypoint.sh`) carries `--request-timeout=10s` on `find_pod`'s
`kubectl get pods`, the deployment lookup, and the `cluster-info` preflight:

```bash
kubectl get pods -n "$namespace" \
  --field-selector=status.phase=Running --request-timeout=10s \
  -l "$selector" -o jsonpath='{.items[0].metadata.name}'
```
```

- [ ] **Step 4: Write the merged `service/STANDARD.md`**

Create `docs/standards/service/STANDARD.md`:

````markdown
---
domain: service
applies_to:
  - "**/controllers/**"
  - "**/handlers/**"
  - "**/routes/**"
  - "**/*.controller.ts"
  - "**/*.service.ts"
  - "**/*.graphql"
  - "**/*.gql"
  - "**/resolvers/**"
  - "**/subgraph*/**"
  - "**/clients/**"
  - "**/*.client.ts"
  - "**/gateways/**"
  - "**/*.gateway.ts"
phase: [implement, review]
summary: Service-boundary contract — REST/Nest conventions, GraphQL federation/Relay, cross-service resilience, contract evolution, and query performance.
---

# Service standard

The service boundary contract: how a service exposes REST/GraphQL and how it
calls its dependencies. The shared comment rubric ([comments.md](comments.md))
applies in full.

## Rules

### REST

- **Resource naming** — plural noun for the resource base (`products`,
  `categories`); kebab-case multi-word segments (`find-by-email`); nest
  sub-resources under the parent id (`/products/:id/categories`), not a flat
  query param.
- **Status codes & error body** — throw the matching built-in Nest exception
  (`NotFoundException`, `BadRequestException`, ...) at the point of failure and
  let Nest's default filter shape the body; don't add a custom `ExceptionFilter`.
  Never wrap an unrelated failure (a DB timeout, a bad filter) in a fixed status
  because it was caught in the same `try`/`catch`.
- **Pagination** — `page` (1-based) + `perPage` query params; envelope
  `{ data, total, page, perPage }`. Don't invent `limit`/`offset` or a bespoke
  per-endpoint envelope.
- **Validate at the boundary** — declare the body/query as a class-validator DTO
  and apply `@UsePipes(new ValidationPipe())` (add `{ transform: true }` for
  coercion). A handler that skips this accepts whatever the caller sends.
- **Nullability contract** — a missing single-resource lookup throws
  `NotFoundException`; it never returns `200` with a null/empty body.

### GraphQL

- **Federation `@key` ownership** — one subgraph owns an entity, others extend
  it; comment which and why the key fields were chosen.
- **Relay connection shape** — paginated fields use the Relay shape with ONE
  shared non-null `PageInfo` and non-null `edges` — not a bespoke
  `{items, nextPage}` or a per-type `PageInfo`. See
  [references/relay-pagination.md](references/relay-pagination.md).
- **Opaque cursors** — base64 a `(sortKey, tiebreaker)` encoding, never a raw
  offset or bare DB id.
- **Nullability as a contract choice** — a nullable field that tolerates a flaky
  upstream deserves a comment saying so, or the next editor "fixes" it to non-null.
- **Sanitize external-system filters** — reject injection into `filter_by`-style
  strings (keep in sync with web-v2 `sanitizeFilterValue`).

### Cross-service resilience

- **Bound every outbound call** — every cross-service/network call carries an
  explicit timeout. An unbounded blocking call inside a retry/poll loop is a
  silent-death bug, not a slow path.
- **Retries need a ceiling + backoff** — no naked `while true` retry without max
  attempts and a per-attempt timeout.
- **Degrade, don't hang** — a down dependency returns a bounded error to the
  caller; never block the request/loop indefinitely.

### Contract evolution

- **Additive by default** — prefer additive changes to a published contract (REST
  endpoint, GraphQL field/type, federation key). No versioning scheme exists
  today; a stray `v1/` prefix is vestigial, not a pattern to copy.
- **Breaking change is measured, not silent** — log a deprecation on the old path
  to measure real usage before removing it, rather than breaking callers in place.

### Performance

- **Batch fan-out** — dataloader-batch resolver fan-out; deliberate non-batching
  only where the fan-out is bounded (and say so in a comment).
- **Cache reads with a freshness contract** — stale-while-revalidate for tolerant
  reads; name the TTL/staleness window; never cache without an expiry/invalidation
  story.

## Don't

- Don't catch a broad error and re-throw it with the raw `error.message` interpolated in — [references/ap-leaky-errors.md](references/ap-leaky-errors.md)
- Don't accept `@Body() body: any`; declare a validated DTO — [references/ap-untyped-boundary.md](references/ap-untyped-boundary.md)
- Don't leave an outbound call unbounded inside a retry loop — [references/ap-unbounded-call.md](references/ap-unbounded-call.md)

## Going deeper

| When you're doing | Read |
|---|---|
| adding pagination to a REST list endpoint | [references/pagination.md](references/pagination.md) |
| deciding what an endpoint returns on not-found / failure | [references/error-contracts.md](references/error-contracts.md) |
| writing catch blocks / exception filters | [references/ap-leaky-errors.md](references/ap-leaky-errors.md) |
| accepting a request body | [references/ap-untyped-boundary.md](references/ap-untyped-boundary.md) |
| designing a paginated GraphQL field | [references/relay-pagination.md](references/relay-pagination.md) |
| making an outbound / cross-service call | [references/ap-unbounded-call.md](references/ap-unbounded-call.md) |
````

- [ ] **Step 5: Delete the old `api/` and `graphql/` domains**

```bash
cd /Users/jayboyer/workspace/sandbox
git rm -r docs/standards/api docs/standards/graphql
```

- [ ] **Step 6: Repoint the archetype `standards:` keys in services.yaml**

Edit `infra/config/services.yaml`: line 29 `standards: [graphql]` → `standards: [service]`; line 33 `standards: [api]` → `standards: [service]`.

- [ ] **Step 7: Run the standards check — expect PASS**

Run **AUTHORING_CHECK** (see Global Constraints).
Expected: no errors about `service`; specifically no "is not linked", "needs an inline don't-line bullet", "TODO(graduate)", or "canonical: TODO" for the six `service/references/*.md`.

- [ ] **Step 8: Update the two affected tests**

In `apps/cli/src/lib/__tests__/workspace_skills.test.ts`, the full-render assertion (currently `workspace_skills.test.ts:63-65`) lists `"sb-api-standard", "sb-graphql-standard"`. Replace those two entries with `"sb-service-standard"`. In the drift test (~line 103/109) replace `sb-graphql-standard` with `sb-service-standard` (both the `.unlink()` path and the expected `"missing: ..."` string).

In `apps/cli/src/lib/__tests__/skill_gen.test.ts:22`, `test_all_repo_modules_generate_a_skill` loops over `("comments", "graphql", "ui", "api", "data")` — a subset (`in`) check against the real `docs/standards/`. Since `api`/`graphql` no longer render, change that tuple to `("comments", "service", "ui", "data")`. (New domains needn't be added — it's a subset check, not an exact-set assertion.)

- [ ] **Step 9: Run the sandbox-cli test suite — expect PASS**

Run: `cd apps/cli && npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts apps/cli/src/lib/__tests__/skill_gen.test.ts -v`
Expected: PASS. If `skill_gen.test.ts` has its own fixtures asserting `sb-api-standard`/`sb-graphql-standard` against the real standards dir (not synthetic tmp fixtures), update those to `sb-service-standard`; leave synthetic-fixture tests (which build their own tmp `api/` dir) unchanged.

- [ ] **Step 10: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add docs/standards infra/config/services.yaml apps/cli/src/lib/__tests__/workspace_skills.test.ts apps/cli/src/lib/__tests__/skill_gen.test.ts
git commit -m "feat(standards): PROJ-1897 merge api+graphql into service domain with resilience/contracts/performance"
```

---

### Task 2: `config` domain

**Files:**
- Create: `docs/standards/config/STANDARD.md`
- Modify: `apps/cli/src/lib/__tests__/workspace_skills.test.ts` (add `sb-config-standard` to the set)

**Interfaces:**
- Consumes: the render/validate pipeline from Task 1 (unchanged).
- Produces: domain key `config`, skill `sb-config-standard`.

- [ ] **Step 1: Write `config/STANDARD.md`**

Create `docs/standards/config/STANDARD.md` (no `references/` — the `## Don't` bullets are plain one-liners, so no `ap-*.md` files are required and none must be linked):

```markdown
---
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
---

# Config standard

How services find and address each other. The shared comment rubric
([comments.md](comments.md)) applies in full.

## Rules

- **Inter-service URLs use stable Docker DNS names** — e.g. `http://web-v2:3060`,
  `http://gke-forwards:9000`. Never `host.docker.internal` from inside a
  container: it doesn't resolve there, so the URL only works on one host.
- **No `{service-name}` placeholder syntax in new env vars** — use the Docker DNS
  alias directly. The placeholder templating is not expanded for new vars and
  silently yields a literal `{service-name}` string.
- **GKE forward ports are container-internal** — reach them at
  `http://gke-forwards:<port>`; never expose a forward port to the host.

## Don't

- Don't hardcode `host.docker.internal` or a host-published port in an
  inter-container URL — it resolves only on the Docker host, not inside the
  container mesh.
- Don't add a `{service-name}` placeholder to a new env var — write the DNS
  alias literally.
```

(No `## Going deeper` section — it has no references yet; graduation adds that
section lazily when the first reference lands.)

- [ ] **Step 2: Run the standards check — expect PASS**

Run **AUTHORING_CHECK** (see Global Constraints).
Expected: no errors for `config`.

- [ ] **Step 3: Add `sb-config-standard` to the skill-set assertion**

In `apps/cli/src/lib/__tests__/workspace_skills.test.ts`, add `"sb-config-standard"` to the full-render set assertion updated in Task 1 Step 8.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/cli && npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add docs/standards/config apps/cli/src/lib/__tests__/workspace_skills.test.ts
git commit -m "feat(standards): add config domain (inter-service URL/DNS conventions)"
```

---

### Task 3: `auth` domain

**Files:**
- Create: `docs/standards/auth/STANDARD.md`
- Modify: `apps/cli/src/lib/__tests__/workspace_skills.test.ts` (add `sb-auth-standard`)

**Interfaces:**
- Produces: domain key `auth`, skill `sb-auth-standard`.

- [ ] **Step 1: Write `auth/STANDARD.md`**

Create `docs/standards/auth/STANDARD.md` (plain `## Don't` one-liners, no references):

```markdown
---
domain: auth
applies_to:
  - "**/auth/**"
  - "**/*.guard.ts"
  - "**/*.strategy.ts"
  - "**/middleware/**"
phase: [implement, review]
summary: Auth boundary — Auth0 audience scoping per service, ID-token vs access-token, shared-session cookie scope, per-service (not global) auth config.
---

# Auth standard

Auth semantics at the service boundary. Config wiring for auth env vars is the
`config` standard's concern; this standard owns the auth *meaning*. The shared
comment rubric ([comments.md](comments.md)) applies in full.

## Rules

- **Audience names an API registered on the target tenant** — a shared/global
  `AUTH0_AUDIENCE` default is a landmine. Sandboxes authenticate against the dev
  tenant; an audience pointing at a prod API the dev tenant doesn't have returns
  Auth0 `access_denied "Service not found"`.
- **Request an audience only when you need an access token** — a service that
  builds its session from the ID token (e.g. sb-web) must set no audience;
  requesting one is both wrong-tenant and unnecessary.
- **Scope shared-session cookies to the common parent domain** — `COOKIE_DOMAIN`
  unset scopes the cookie to the emitting host, so a downstream gate (web-v2 admin)
  never sees the upstream (web-v1) session. Scope to the shared parent domain.
- **Per-service auth config lives at the service level, never the global** — set
  it per service (`services.yaml`), not the shared `env.j2`; siblings read the
  same var with their own audiences and must not be affected.

## Don't

- Don't set `AUTH0_AUDIENCE` to an API the authenticating tenant hasn't
  registered — login fails with `access_denied "Service not found"`.
- Don't change a shared/global auth env default to fix one service — scope the
  change to that service.
```

(No `## Going deeper` section yet — see the `config` standard for the wiring
mechanics; graduation adds a references index here lazily.)

- [ ] **Step 2: Run the standards check — expect PASS**

Run **AUTHORING_CHECK** (see Global Constraints).
Expected: no errors for `auth`.

- [ ] **Step 3: Add `sb-auth-standard` to the skill-set assertion**

In `apps/cli/src/lib/__tests__/workspace_skills.test.ts`, add `"sb-auth-standard"` to the full-render set.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/cli && npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add docs/standards/auth apps/cli/src/lib/__tests__/workspace_skills.test.ts
git commit -m "feat(standards): PROJ-1897 add auth domain (Auth0 audience/session scoping)"
```

---

### Task 4: `testing` domain (thin seed)

**Files:**
- Create: `docs/standards/testing/STANDARD.md`
- Modify: `apps/cli/src/lib/__tests__/workspace_skills.test.ts` (add `sb-testing-standard`)

**Interfaces:**
- Produces: domain key `testing`, skill `sb-testing-standard`.

- [ ] **Step 1: Write `testing/STANDARD.md`** (2 rules, thin — the loop fattens it)

Create `docs/standards/testing/STANDARD.md`:

```markdown
---
domain: testing
applies_to:
  - "**/*.spec.ts"
  - "**/*.test.ts"
  - "**/e2e/**"
  - "**/__tests__/**"
  - "**/*_test.ts"
phase: [implement, review]
summary: Test boundaries in a distributed system — unit vs integration vs contract tests, what to mock at a service seam.
---

# Testing standard

Where to draw test boundaries in a system of cooperating services. The shared
comment rubric ([comments.md](comments.md)) applies in full.

## Rules

- **Test at the right seam** — unit-test pure logic in isolation; integration-test
  a service against its real dependencies via the sandbox; never mock the thing
  actually under test.
- **Contract over end-to-end for cross-service** — assert the boundary contract
  (schema / DTO shape) rather than a brittle full-stack path when a focused
  contract test would catch the same regression.

## Don't

- Don't mock the unit under test to make a test pass — you are then testing the
  mock, not the code.
```

(No `## Going deeper` section — thin seed; graduation adds it when the first real
nit graduates here.)

- [ ] **Step 2: Run the standards check — expect PASS**

Run **AUTHORING_CHECK** (see Global Constraints).
Expected: no errors for `testing`.

- [ ] **Step 3: Add `sb-testing-standard` to the skill-set assertion**

Add `"sb-testing-standard"` to the full-render set in `workspace_skills.test.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/cli && npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add docs/standards/testing apps/cli/src/lib/__tests__/workspace_skills.test.ts
git commit -m "feat(standards): add testing domain (thin seed — test seam boundaries)"
```

---

### Task 5: `observability` domain (thin seed)

**Files:**
- Create: `docs/standards/observability/STANDARD.md`
- Modify: `apps/cli/src/lib/__tests__/workspace_skills.test.ts` (add `sb-observability-standard`)

**Interfaces:**
- Produces: domain key `observability`, skill `sb-observability-standard`.

- [ ] **Step 1: Write `observability/STANDARD.md`** (2 rules, thin)

Create `docs/standards/observability/STANDARD.md`:

```markdown
---
domain: observability
applies_to:
  - "**/instrumentation/**"
  - "**/telemetry/**"
  - "**/*.otel.*"
  - "**/logging/**"
  - "**/*.logger.ts"
phase: [implement, review]
summary: Telemetry — OTel span/attribute conventions, structured logging, trace/correlation-ID propagation across service hops.
---

# Observability standard

Telemetry conventions where instrumentation and logging are defined. (Spans and
logs appear anywhere in business logic; this standard's glob covers the
instrumentation/logging surface, where the conventions bite hardest.) The shared
comment rubric ([comments.md](comments.md)) applies in full.

## Rules

- **Propagate trace context across every hop** — an outbound call forwards trace
  context so a request is one trace end-to-end, not orphaned spans.
- **Log structured, not string-interpolated** — key/value fields, never a
  formatted sentence that can't be queried.

## Don't

- Don't emit a log as a pre-formatted sentence with values baked into the string
  — attach them as structured fields instead.
```

(No `## Going deeper` section — thin seed; graduation adds it when the first real
nit graduates here.)

- [ ] **Step 2: Run the standards check — expect PASS**

Run **AUTHORING_CHECK** (see Global Constraints).
Expected: no errors for `observability`.

- [ ] **Step 3: Add `sb-observability-standard` to the skill-set assertion**

Add `"sb-observability-standard"` to the full-render set in `workspace_skills.test.ts`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/cli && npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add docs/standards/observability apps/cli/src/lib/__tests__/workspace_skills.test.ts
git commit -m "feat(standards): add observability domain (thin seed — telemetry conventions)"
```

---

### Task 6: Activate new domains on the right archetypes + full verification

**Files:**
- Modify: `infra/config/services.yaml` (archetype `standards:` lists)
- Test: full `cli/tests/` suite + a throwaway-workspace spot check

**Interfaces:**
- Consumes: all five domains from Tasks 1–5.
- Produces: the new domains active (loadable) on the archetypes whose code they govern.

> **Decision needed at execution time (confirm with the user):** which archetypes
> get which new domain. Default mapping below; adjust to the actual archetype set
> in `services.yaml` (`nextjs-ui`, `nest-api`, `graphql-subgraph`, `data-pipeline`).
> `config` + `auth` are broad (any deployable service); `testing` is broad;
> `observability` is broad. Without this step the domains render and are
> graduation-eligible but never load in any workspace.

- [ ] **Step 1: Add the new domains to archetype `standards:` lists**

Edit `infra/config/services.yaml`. Default mapping (each list is additive to what the archetype already has):
- `nextjs-ui` → add `config`, `auth`, `testing`, `observability`
- `nest-api` → `service` already; add `config`, `auth`, `testing`, `observability`
- `graphql-subgraph` → `service` already; add `config`, `testing`, `observability`
- `data-pipeline` → `data` already; add `config`, `testing`, `observability`

- [ ] **Step 2: Run the full sandbox-cli test suite — expect PASS**

Run: `cd apps/cli && npx vitest run cli/tests/ -q`
Expected: PASS (0 failures).

- [ ] **Step 3: Standards check — expect PASS**

Run **AUTHORING_CHECK** (see Global Constraints).
Expected: no errors.

- [ ] **Step 4: Spot-check a throwaway workspace's routing table**

Create a scratch workspace against a nest-api + graphql-subgraph repo set and confirm the generated `CLAUDE.md` "Standards routing" table lists `service` (with the union globs), `config`, `auth`, `testing`, `observability`, and no longer lists `api`/`graphql`.

Run: `node apps/cli/dist/main.js workspace scratch-standards-check --repos <nest-api-repo>,<graphql-subgraph-repo> --print-form-schema` is NOT the check; instead init and inspect:
```bash
node apps/cli/dist/main.js init-workspace   # in a throwaway worktree wired to those repos
grep -A20 "## Standards routing" CLAUDE.md
```
Expected: rows for `service`/`config`/`auth`/`testing`/`observability`; no `api`/`graphql` rows.

- [ ] **Step 5: Commit**

```bash
cd /Users/jayboyer/workspace/sandbox
git add infra/config/services.yaml
git commit -m "feat(standards): activate config/auth/testing/observability on service archetypes"
```

---

## Notes for the executor

- **The GKE resilience war story is already fixed in-repo** (`entrypoint.sh` carries `--request-timeout=10s`). `ap-unbounded-call.md` documents it as a fixed anti-pattern with the real canonical — do not "re-open" it as a live bug.
- **Thin domains (`testing`, `observability`) ship 2 rules on purpose.** Don't pad them — the authoring loop fattens them from real review nits. A thin-but-real seed beats an invented-thick one.
- If `skill_gen.test.ts` turns out to assert `sb-api-standard`/`sb-graphql-standard` only inside synthetic tmp fixtures (which build their own `api/` dir), leave those alone — they don't read the real `docs/standards/`.
