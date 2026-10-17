---
"@jbbz-sandbox/sandbox-cli": patch
---

Workspace `docker compose` calls now pass `-p sandbox-<feature>` (#225). Running `sandbox workspace` inside another workspace's container no longer builds the new workspace's images under the caller's `COMPOSE_PROJECT_NAME`, so the caller's containers are no longer recreated or removed and the new containers carry their own project label. Covers the init build, every `compose.ts` lifecycle/logs call, and the VS Code log tail (#198 fixed the same leak for infra only).
