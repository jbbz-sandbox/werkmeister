---
domain: auth
applies_to:
  - "**/auth/**"
  - "**/*.guard.ts"
  - "**/*.strategy.ts"
  - "**/middleware/**"
phase: [implement, review]
task_signatures:
  - "auth0"
  - "oauth"
  - "jwt"
  - "audience"
  - "id-token"
  - "id token"
  - "access-token"
  - "access token"
  - "authenticat"
  - "authoriz"
  - "tenant"
  - "session cookie"
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
  builds its session from the ID token must set no audience;
  requesting one is both wrong-tenant and unnecessary.
- **Scope shared-session cookies to the common parent domain** — `COOKIE_DOMAIN`
  unset scopes the cookie to the emitting host, so a downstream gate on one
  service never sees the session issued by another. Scope to the shared parent domain.
- **Per-service auth config lives at the service level, never the global** — set
  it per service (`services.yaml`), not the shared `env.j2`; siblings read the
  same var with their own audiences and must not be affected.

## Don't

- Don't set `AUTH0_AUDIENCE` to an API the authenticating tenant hasn't
  registered — login fails with `access_denied "Service not found"`.
- Don't change a shared/global auth env default to fix one service — scope the
  change to that service.
