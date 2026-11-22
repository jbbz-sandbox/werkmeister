---
"werkmeister": minor
"werkmeister-core": minor
---

A Jira issue's parent epic now shows where its context is read (SW-633). `werkmeister issue view` prints `Parent: <KEY> <summary>` and the epic's description, where an epic keeps the links its stories cite. `.werkmeister/issue.md` stores the same under `## Parent`, and the workspace's `## Issue` section (BRIEF.md, CLAUDE.md) names the parent. The REST fetch asks for the `parent` field and reads the epic in one more request; when that request fails, the key and summary still show. The Atlassian-MCP fallback and GitHub issues show no parent.
