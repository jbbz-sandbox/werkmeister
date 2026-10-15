---
"@jbbz-sandbox/sandbox-cli": minor
---

Every workspace's `.claude/settings.json` now gets `permissions.allow` rules for its services' registry test commands (the `docker exec` line `sandbox-context.md` prints, plus the bare command) and read-only git (`git diff`, `git status`, `git ls-files`), for both context strategies, on init and every `sandbox up`. Sandbox records the rules it added in `.sandbox/claude-permissions.json` and only ever removes those; hand-added rules are kept. `sandbox setup` gains an optional step that grants Claude Code read access to the standards dir in the user-level `~/.claude/settings.json` (`permissions.additionalDirectories`), so no machine path lands in a workspace; it asks first, and `--yes` never grants. (#144)
