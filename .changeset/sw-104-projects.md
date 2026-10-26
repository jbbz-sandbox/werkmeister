---
"werkmeister-core": minor
"werkmeister": minor
---

SW-104: projects. A `projects:` map in `~/.werkmeister/config.yaml` names tracking strategies — a tracker (Jira project key, or GitHub org and optional repos), an optional board, and its own `issue_statuses` — so one machine can work on a Jira-tracked product and a GitHub-tracked one. A workspace records its project as `project:` in `workspace.yml` (`--project` on `workspace` / `init-workspace`; the create form and wizard ask after the issue, defaulting to the project whose scope holds the ref, else `default: true`), and its issue link, status moves and `pr open` / ship updates go to that project's tracker. `config --check` names invalid projects; `connect` checks each project's tracker; `config` and `setup` keep `projects:` when they rewrite the file. A machine with no projects, and a workspace with no `project:`, behave as before.
