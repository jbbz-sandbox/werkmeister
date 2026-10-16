---
"@jbbz-sandbox/sandbox-cli": minor
---

`sandbox pr adopt <pr-number|url> [repo]` closes out a workspace whose fix landed somewhere else. It writes the PR file from `gh pr view` and records its status, so a merged PR is promoted to `shipped` with its release tag. `sandbox pr adopt --no-pr "<reason>"` covers a fix that is already on base with no PR: it writes a `closed` PR file with the reason. Close-out doesn't delete an adopted PR's branch. A PR file whose frontmatter isn't valid YAML now reports the parser's error.
