---
domain: engineering
applies_to:
  - "**/*"
phase: [implement, review]
summary: Cross-cutting engineering constraints — architectural fit, additive & reversible change, performance budgets, smallest-change discipline, and reviewable PRs.
---

# Engineering standard

The cross-cutting constraints the **code artifact** must satisfy, independent of
which file you are in. This is the universal architectural base — loaded on every
code edit alongside the comment rubric ([comments.md](comments.md)), never gated
to a file type. It states the *posture*; the file-type mechanics that enforce it
live in the domain standards this doc points at ([service.md](service.md) for the
service boundary in particular). Read those for the how; this for the always-true
what.

## Rules

### Architectural fit

- **Fit the model, don't route around it.** This is a federated GraphQL graph —
  NestJS subgraphs behind a Hive/Apollo router. A subgraph owns its types; to
  reference another's entity, return an `@key` reference and let the router
  resolve it — never reach across a boundary or join foreign data inside a
  resolver. The `@key` ownership mechanics are in [service.md](service.md).
- **Reuse the existing pattern before inventing one.** The established mechanisms
  (Typesense↔Mongo change-stream sync, the dedicated search subgraph returning
  `@key` references, router-level auth directives) exist for reasons — extend
  them; don't stand up a parallel mechanism that does the same job differently.
  This is `ponytail` rung 2 (already in the codebase) at the architecture scale.
- **New infrastructure is a separate, surfaced decision.** A new datastore,
  queue, service, or heavyweight dependency is never smuggled in as an
  implementation detail of a feature — it is raised and justified on its own.

### Compatibility & rollout

- **Additive and non-breaking by default.** Add fields/types; don't remove or
  repurpose ones consumers depend on. A genuinely necessary breaking change
  becomes its own tracked deprecation with a migration path, not a side effect.
  The contract-evolution mechanics (deprecation logging to measure real usage)
  are in [service.md](service.md).
- **Every risky change has a rollout story.** Anything with data movement or real
  risk names its feature flag, backfill path, and a way to disable it. A change
  with no rollback path is not ready to ship.
- **Version stateful contracts instead of mutating in place.** When a moderation
  status, publication flag, or similar stateful shape changes, version it so
  in-flight data stays interpretable.

### Performance budgets

These are gates the code is written to and tested against — not aspirations.

- **No N+1.** Resolvers must not fan out per-item queries; batch (dataloader) or
  restructure. The batching mechanics live in [service.md](service.md); this is
  the flat prohibition that holds everywhere.
- **An index is a precondition, not a follow-up.** A query pattern that needs an
  index doesn't ship without it — state the required index as part of the change.
- **Respect latency / query-complexity ceilings.** If a path has a budget, the
  design states it and a test verifies it. Cold-connection costs (e.g. Typesense)
  count against the budget.

### Smallest change

- **Prefer the smallest change that correctly solves the problem.** Extend what
  exists rather than rewriting it; a greenfield reimplementation needs an
  explicit, separately-justified reason ("the old code is awkward" isn't one).
  Don't build for hypothetical future requirements. This is the `ponytail`
  decision ladder — load it and apply it; this bullet is the reminder that it
  governs architecture, not just line-level code.

### Reviewable PRs

- **One PR, one story, reviewable in one sitting.** A change that can't be
  reviewed in a single pass is split into an ordered sequence of
  independently-mergeable PRs. A 2,000-line PR is a process failure, not a big
  feature. Don't fold an unrelated refactor into a feature PR — separate them.
  The PR *conventions* (title, body, ticket, Jira transition) belong to `sb-pr`;
  this is only the *sizing* discipline that shapes the diff before you get there.

## Don't

- Don't stand up a parallel datastore/service/dependency inside a feature diff —
  surface it as its own decision (Architectural fit).
- Don't ship a schema/contract change that removes or repurposes a field
  consumers depend on without a tracked deprecation + migration path.
- Don't merge a resolver that fans out per-item queries, or a query that needs an
  index without the index.
- Don't open a PR that mixes an unrelated refactor into a feature, or one too
  large to review in a sitting.

## Going deeper

| When you're doing | Read |
|---|---|
| touching the service boundary (REST/GraphQL, resilience, contract evolution, perf mechanics) | [service.md](service.md) |
| deciding whether a change is minimal / already-solved | `ponytail` (the decision ladder) |
| shaping and opening the PR | `sb-pr` (conventions), `sb-review` (self-review) |
