---
"werkmeister": minor
"werkmeister-core": minor
---

The Claude adapter's `ask` helpers (starting-prompt refine, issue distillation, the Jira Atlassian-MCP fallback) run through the Agent SDK with structured output instead of scraping `claude -p`'s stdout: a failed run names the SDK's result subtype. `@anthropic-ai/claude-agent-sdk` is a required dependency of `werkmeister` again (SW-386).
