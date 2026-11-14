---
"werkmeister-core": patch
---

`@anthropic-ai/claude-agent-sdk` is now an optional peer dependency of werkmeister-core, so `npm i werkmeister-core` no longer installs it or its ~240 MB `claude-agent-sdk-<platform>` binary. Only the `ask` helpers (refine, issue distillation, the Jira MCP fallback) load it; without it, `askOrThrow` fails with "Asking Claude needs the Claude Agent SDK, which is not installed" and the install command, and `ask`/`askJson` return null as for any other failure. Install it beside core to use them. The `werkmeister` CLI still depends on it.
