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
task_signatures:
  - "env var"
  - "env-var"
  - "environment variable"
  - "docker-compose"
  - "services.yaml"
  - "inter-service"
  - "dns"
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
