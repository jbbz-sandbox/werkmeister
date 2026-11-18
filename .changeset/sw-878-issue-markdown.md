---
"werkmeister": patch
---

SW-878: an issue fetched from Jira REST now reads as Markdown, not Jira wiki markup, in `.werkmeister/issue.md` and `werkmeister issue view`: `{{code}}` becomes backticks, `\-` escapes are dropped, smart links become Markdown links named by their issue key, and headings, lists, bold and `{code}` blocks are converted.
