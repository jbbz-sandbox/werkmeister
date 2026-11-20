---
"werkmeister": patch
---

In an autonomous workspace, `werkmeister pr gate` (and `pr open`, which runs it) run by an agent or through the daemon (the `workspace-pr` MCP tool, the pane), anything but a person's terminal, no longer recreates a service that mounts the docker socket, the werkmeister home or a workspaces root when the branch's fragment changes its `command`, `image`, `build`, `entrypoint`, `archetype`, mounts or `environment`. The gate fails with a `start <service>` row instead, and the person runs `werkmeister pr gate` from their own terminal. Before, a changed `command:` ran as root with those mounts, past SW-854's start rules (SW-891).

A fragment whose service `path` has a `..` segment now fails the registry merge: compose mounts `<repo>/<path>/src` read-write, so it reached another workspace.
