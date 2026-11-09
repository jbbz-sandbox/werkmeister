/**
 * The rules an unattended run never gets (SW-385: moved out of claude/hooks_gen.ts so the
 * OpenCode adapter shares them). Written in Claude Code's permission syntax; other harnesses
 * translate them.
 */
export const PLUGIN_MCP_PREFIXES = ["mcp__plugin_werkmeister_werkmeister__"];
export const pluginTool = (tool: string) => PLUGIN_MCP_PREFIXES.map((prefix) => `${prefix}${tool}`);

// Every name the CLI answers to. A `Bash(…)` rule is a literal prefix, so a rule
// for one name never matches a call through another: rules written only for
// `werkmeister` left `w9r …` calls unapproved.
export const CLI_NAMES = ["werkmeister", "w9r"];
export const cli = (rule: string) => CLI_NAMES.map((name) => `Bash(${name} ${rule})`);

// Shared infra, other workspaces, the linked CLI and outward-facing acts. Deny
// outranks allow, including a person's broader user-level rule (`Bash(npm:*)`
// in ~/.claude/settings.json). Own-workspace acts a person may approve
// interactively (`close-out`, `workspace-pr`) are left unallowed, not denied.
// shortcut: prefix rules — `npm install foo -g`, an agent-edited test script or a repo's own git
// hook still runs (SW-522); a runner without host mounts is the upgrade if runs need a hard boundary.
export const AUTONOMOUS_DENY = [
  // SW-560: `Bash(git:*)` is allowed, and an alias, pager, fsmonitor or hook set through config, or a
  // git-* binary on --exec-path, runs any command. No `* -c *`/`* config *` forms: deny beats allow, and they
  // refuse `git commit -m "fix config"`; `git -C <dir> -c …` is SW-626's.
  "Bash(git -c:*)",
  "Bash(git config:*)",
  ...["--config", "--exec-path", "--template"].flatMap((flag) => [
    `Bash(git ${flag}*)`,
    `Bash(git * ${flag}*)`,
  ]),
  "Bash(git --git-dir*)",
  // SW-521: a registered test chain's bare `node --test` segment (buildAllowRules) runs any file
  // with the real HOME; npx and pnpm exec segments name their tool, so they stay allowed.
  "Bash(node:*)",
  "Bash(python3:*)",
  ...[
    "proxy-reload",
    "down",
    "remove",
    "remove-workspace",
    "clean",
    "setup",
    "registry",
    "connect",
    "intercept",
    "notes graduate",
    "up infra",
    "restart infra",
    "stop infra",
    // SW-186's spellings of the same; `workspace:*` became `workspace new`, as a bare
    // `workspace` prefix would also deny `workspace init`.
    "infra proxy-reload",
    "feature down",
    "infra down",
    "feature drop",
    "machine clean",
    "machine setup",
    "infra connect",
    "infra intercept",
    "workspace new",
    "ws new",
    "infra up",
    "infra restart",
    "infra stop",
    "daemon install",
    "daemon uninstall",
    "daemon restart",
  ].flatMap((cmd) => cli(`${cmd}:*`)),
  ...["stop", "kill", "rm", "rmi", "compose down", "system prune", "volume rm", "network rm"].map(
    (cmd) => `Bash(docker ${cmd}:*)`,
  ),
  ...["npm", "pnpm"].flatMap((pm) =>
    [
      "publish",
      "link",
      "unlink",
      "install -g",
      "install --global",
      "i -g",
      "i --global",
      "uninstall -g",
      "uninstall --global",
    ].map((cmd) => `Bash(${pm} ${cmd}:*)`),
  ),
  ...["add -g", "add --global", "remove -g", "remove --global"].map((cmd) => `Bash(pnpm ${cmd}:*)`),
  "Bash(gh pr merge:*)",
  ...[
    "kube-switch",
    "up",
    "stop",
    "restart",
    "down",
    "create-workspace",
    "create-workspace-form",
    "pr-approve",
    "ask-pr-review",
    "claude-send",
    "claude-resume",
    "connect",
    "proxy-reload",
    "remove-service",
    "intercept",
  ].flatMap(pluginTool),
];
