---
"sandbox-core": minor
"@jbbz-sandbox/sandbox-cli": minor
---

`sandbox setup` asks for the issue tracker (`overrides.issue_tracker`: `jira` or `github`). With `github`, issues are per repo and the tracker spans every repo in the services registry under `github_org`: `sandbox workspace` asks for a GitHub issue (`repo#n`, `owner/repo#n` or an issue URL; `--github-issue`) instead of a Jira ID, `CLAUDE.md` links it, and the bug guide sends existing app-code bugs to those repos' issues. With `jira`, the bug guide sends them to the workspace ticket's Jira project. Jira links now use `jira.base_url` instead of a hardcoded site.
