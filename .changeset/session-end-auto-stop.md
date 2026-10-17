---
"@jbbz-sandbox/sandbox-cli": minor
---

Workspaces take an opt-in `auto_stop` (#231): `--auto-stop` on `sandbox workspace` / `sandbox init-workspace`, `SANDBOX_AUTO_STOP`, `auto_stop: true` in `workspace.yml`, or the create form's checkbox. It writes a managed SessionEnd hook to the workspace's `.claude/settings.json` (hand-added hooks are kept; turning it off removes only sandbox's entry) that runs the new `sandbox stop --if-idle`: when the session ends and no other Claude session is open in the workspace, the workspace's own feature containers stop in the background, keeping the slot and volumes so `sandbox up` resumes fast. It never stops shared infra, prints nothing and always exits 0. `sandbox-context.md` says so in Container Lifecycle while it is on. Workspaces without `auto_stop` behave as before.
