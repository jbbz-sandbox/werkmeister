---
"werkmeister": minor
---

SW-190: a service in a repo's `.werkmeister/services.yaml`, or its archetype, can carry `stages:` text keyed by role (`research`, `spec`, `implement`, `exercise`). ICM init adds it to the matching stage contract of each workspace that covers the service, under `## For this workspace's services`. A workflow's `workflow.yaml` stage can take it with `role:`, and `werkmeister workflow export` writes the built-in roles. A value over 600 characters, an unknown role or non-text fails init before it writes `.env` or any stage contract. Workspaces with no stage text render as before.
