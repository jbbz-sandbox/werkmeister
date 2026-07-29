# Sandbox — Code Style Guide

> **Canonical, cross-repo standard — now a thin index.** The rubric and per-repo notes
> that used to live in this file are decomposed into one module per concern under
> [docs/standards/](standards/), each carrying frontmatter (`domain:`, `applies_to:`,
> `phase:`) consumed by the sandbox's JIT standards loading
> (see [jit-standards-loading-spec.md](jit-standards-loading-spec.md)).
> Edit the modules; this index just routes.
>
> Living documents. When a code review keeps surfacing the same nit, encode it in the
> matching module so it only has to be said once. Start small; extend as patterns emerge.

## Universal

| Module | Applies to | Summary |
|--------|-----------|---------|
| [standards/comments.md](standards/comments.md) | every code edit | Comments explain the **why**, never the **what** — rubric, test, examples |

## Domain modules

| Module | Domain | Applies to | Summary |
|--------|--------|-----------|---------|
| [standards/service/STANDARD.md](standards/service/STANDARD.md) | service | controllers, resolvers, `*.graphql`, clients | REST/Nest + GraphQL federation/Relay, cross-service resilience, contract evolution, query performance |
| [standards/ui.md](standards/ui.md) | ui | `*.tsx`, `*.jsx`, components, hooks | Render/effect ordering, hydration, CDN cache-key versioning |
| [standards/data.md](standards/data.md) | data | DAGs, pipelines, `*.py` | Airflow ordering/scheduling, epoch-ms conventions |
| [standards/config/STANDARD.md](standards/config/STANDARD.md) | config | `*.env`, `config/`, `services.yaml`, compose | Inter-service URL/DNS conventions, env-var rules |
| [standards/auth/STANDARD.md](standards/auth/STANDARD.md) | auth | `auth/`, `*.guard.ts`, `*.strategy.ts`, middleware | Auth0 audience scoping, ID vs access token, session cookie scope |
| [standards/testing/STANDARD.md](standards/testing/STANDARD.md) | testing | `*.spec.ts`, `*.test.ts`, `e2e/`, `__tests__/` | Unit vs integration vs contract test boundaries |
| [standards/observability/STANDARD.md](standards/observability/STANDARD.md) | observability | `instrumentation/`, `telemetry/`, `*.logger.ts` | OTel span/attribute conventions, structured logging, trace propagation |

## Per-repo notes

The rubric is identical everywhere; what differs per repo is *which* quirks most often
justify a comment. One snippet per repo under [standards/repos/](standards/repos/):

[cloudflare-workers](standards/repos/cloudflare-workers.md) ·
[comx](standards/repos/comx.md) ·
[data-engineering](standards/repos/data-engineering.md) ·
[econx](standards/repos/econx.md) ·
[logging-service](standards/repos/logging-service.md) ·
[shared](standards/repos/shared.md) ·
[taxonomy-service](standards/repos/taxonomy-service.md) ·
[sb-web](standards/repos/sb-web.md) ·
[sandbox](standards/repos/sandbox.md)

## How standards reach a workspace

Which modules apply to a given ephemeral workspace is computed from the `standards:`
field per service in `infra/config/services.yaml` (plus `.sandbox/workspace.yml`
`standards_override`) and rendered as a **"Standards routing"** block in the workspace's
generated `CLAUDE.md`. `comments` is universal and always active.
