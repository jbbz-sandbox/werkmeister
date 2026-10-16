---
"sandbox-core": patch
---

Shared-infra `docker compose` calls now pass `-p sandbox-infra`, so a caller whose env sets `COMPOSE_PROJECT_NAME` (every workspace container) no longer addresses the shared stack as its own project, which used to report k8s-forwards unhealthy and then fail restarting it. `sandbox up`/`down`/`stop`/`restart` run inside the target feature's own container now refuse with `INSIDE_OWN_CONTAINER` instead of killing themselves with exit 137 (#198).
