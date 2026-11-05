---
"werkmeister-core": patch
---

SW-434: the generated `issues-report.md` search step also searches by the workspace's name (Jira `text ~ "<workspace>"`, GitHub `--search "<workspace>"`), since other sessions file from the same review and exercise files and an issue filed from a workspace names it.
