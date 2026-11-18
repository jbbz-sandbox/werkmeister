---
"werkmeister-core": patch
---

Autonomous workspaces no longer pre-approve starting or restarting a service whose mounts give it the docker socket, the werkmeister home, the workspaces or repos root (or a parent), another workspace or a checkout under those roots (`feature up --service <svc>`, `docker restart <feature>-<svc>`), nor a whole-feature `feature up`/`restart` while such a service is selected: its `command:` often runs a package script the agent can edit. A new registry field, `unattended_start: <reason>`, keeps the rules for a service shown to run no such script. Only the machine registry's value counts, and only while the branch's fragment leaves the service's `command`, `image`, `build`, `entrypoint`, `archetype`, mounts and `environment` as the registry has them (SW-854).
