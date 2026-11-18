---
"werkmeister-core": patch
---

Autonomous workspaces no longer pre-approve `werkmeister feature test|logs|services <feature>:*`. The prefix let an agent run `feature test <feature> -w <other> --scaffold`, which writes another workspace, and `feature test <feature> -- --config=<file>`, which runs any JS through Playwright. `feature services <feature>` and `feature logs <feature>` (with or without one of the workspace's own services) are now exact, plus their pre-SW-186 spellings. `feature test` has no rule and asks: even exact, it runs the workspace's own `playwright.config.*`, which the agent can write, with the real HOME. The threat model now records the `host.docker.internal` probe: a container has no network route to Docker, but it does reach the werkmeister daemon with its workspace's token (SW-855).
