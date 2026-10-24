---
"werkmeister": patch
---

`werkmeister issue create` and `issue update --comment` convert Markdown to Jira wiki markup before sending it through Jira REST, so headings, lists, bold, code spans, fenced blocks and links render in Jira. Before, `## Ask` turned into a numbered list and `**bold**` stayed literal.
