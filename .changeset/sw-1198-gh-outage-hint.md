---
"werkmeister": patch
"werkmeister-core": patch
---

When `gh pr create` or the push fails inside `werkmeister pr open`, it reads githubstatus.com (5 s timeout) and, if Pull Requests or Git Operations is not operational, adds a line naming the component and its status, saying nothing was created and to retry once githubstatus.com shows it operational. If the status call fails, nothing extra is printed (SW-1198).
