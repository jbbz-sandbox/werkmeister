---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1143: when a stage contract drifts, `werkmeister skills check` also names a service's `stages:` text in the registry (after `werkmeister registry sync`) as a cause, not only a werkmeister upgrade. A malformed `stages:` entry prints as one `[err]` line from `skills check` / `skills sync` and the MCP `skills` tool, as `workspace init` does. docs/registry-fragments.md § Stage text says `werkmeister skills sync` brings an edit into an existing workspace.
