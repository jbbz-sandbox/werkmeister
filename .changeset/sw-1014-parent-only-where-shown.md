---
"werkmeister": patch
---

SW-1014: a Jira status move (`issue start`, `pr open`, close-out) reads the issue with one request again. The parent epic's description is fetched only where it is shown: `werkmeister issue view`, `.werkmeister/issue.md` and the create form's issue prompt.
