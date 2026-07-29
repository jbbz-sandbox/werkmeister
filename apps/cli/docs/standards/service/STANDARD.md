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
  - "**/*.data-source.ts"
  - "**/*.datasource.ts"
  - "**/*.graphql.module.ts"
phase: [implement, review]
task_signatures:
  - "federation"
  - "subgraph"
  - "apollo gateway"
  - "remotegraphqldatasource"
  - "willsendrequest"
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
  strings (keep the sanitizer in sync across every caller).

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
