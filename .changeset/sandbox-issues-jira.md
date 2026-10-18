---
"@jbbz-sandbox/sandbox-cli": minor
---

Sandbox-tool issues can go to Jira: set `overrides.sandbox_issues_project` (e.g. `SW`) under `issue_tracker: jira` and the generated issues guide routes them, and the search step, to that project instead of GitHub (unset keeps GitHub). New `sandbox issue create --project <KEY> --type bug|feature|task --title ... --body-file ...` files a Jira issue over REST and prints its URL; a project without the mapped type (Bug) gets a Task labelled with it. The guide's app-code row under Jira now uses it too. Jira REST errors now include Jira's reason.
