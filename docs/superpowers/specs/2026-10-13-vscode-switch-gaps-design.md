# VS Code switch: close the gaps between "folder 0" and "Claude is here"

Findings from a read of `packages/vscode-plugin` on 2026-10-13, written for the
session that implements them. Nothing here is built yet.

## Goal

From the Workspaces tree view, pick a feature under `paths.workspaces_root`
(`~/features`) and have the Claude Code extension work in that feature: its
`CLAUDE.md` loaded as the project root, the previous feature out of the way,
and the current one visible without opening the tree.

## What already exists

`sandbox.switch` ("Switch to Workspace") in
[packages/vscode-plugin/src/commands.ts](../../../packages/vscode-plugin/src/commands.ts)
splices the chosen workspace to folder 0 of the current window: added if not
open, moved up if it is, no-op if already first. One `updateWorkspaceFolders`
call, custom folder names passed back. Commit `06f26bd` did this because the
Claude Code extension spawns its process in workspace folder 0. The tree marks
folder 0's workspace `current` and hides the inline switch arrow on it.
The installed build (`jbbz.vscode-plugin-0.3.0`) has this version.

The Claude Code docs (`code.claude.com/docs/en/vs-code`, `/memory`,
`/cli-reference`) document no root setting, no folder picker, no flag that
retargets `CLAUDE.md`, and nothing about multi-root windows. Folder 0 is an
empirical finding from this repo, not a documented contract. The extension
(`anthropic.claude-code@2.1.296`) contributes `claude-vscode.newConversation`
and the settings `claudeCode.claudeProcessWrapper` and
`claudeCode.environmentVariables`; the wrapper is the only documented hook for
changing how the process launches and is not needed for any of this.

## Gaps

### 1. The live Claude session keeps the old root

The process cwd is fixed at spawn. A switch changes folder 0 but the open
conversation still reads the previous feature's `CLAUDE.md` until a new one
starts. Nothing tells the person that.

Fix: after a successful splice, run the extension's own command.

```ts
await vscode.commands.executeCommand("claude-vscode.newConversation");
```

Verify once by hand that the new conversation's cwd is the new folder 0;
add that check to `MANUAL-CHECKLIST.md`. If the Claude Code extension is not
installed the command rejects; catch and ignore, the splice still stands.

### 2. Features pile up as extra folders

Every switch keeps the previous feature as folder 1, 2, 3… The window ends up
multi-root over every feature touched, and the tree's `current` rule has to
walk folders in order to stay right.

Fix: when building `rest`, drop any folder that lies under
`paths.workspaces_root` other than the one being promoted. `~/features` itself
and unrelated folders survive. `listWorkspaces()` already returns the root.

```ts
const wsRoot = listed.root;
const rest = folders.filter(
  (f) => f.uri.fsPath !== uri.fsPath && !f.uri.fsPath.startsWith(wsRoot + path.sep),
);
```

`switchWorkspace` currently calls `pickWorkspace`, which calls
`listWorkspaces()` only on the palette path. Either return `root` from
`pickWorkspace` or call `listWorkspaces()` again in `switchWorkspace`; the
second is one cheap read and the smaller diff.

### 3. Nothing shows which feature Claude sees

The only indicator is the `current` marker inside the tree, which is hidden
when the view is collapsed.

Fix: a status bar item in `extension.ts` showing `$(zap) <basename of folder 0>`,
`command: "sandbox.switch"`, updated on `onDidChangeWorkspaceFolders`. About
ten lines. This is the status bar item the plugin README's "Not included" list
already names, so update that list.

## Outside the plugin

`~/features/CLAUDE.md` tells Claude to use "the pane's **Switch**" for working
on an existing workspace. The shipped `/workspaces` pane
(`plugins/sandbox-tools/hooks/register.tsx`) has no Switch: the probe note in
the plugin README records that `change_directory` works only after a folder
approval, and the pane shipped "＋ New session" and "↗ Continue in Desktop /
VS Code / Terminal" instead. Point the router row at those buttons, or at the
VS Code command, so Claude stops directing people to a button that is not
there.

## Not in scope

A folder dialog for arbitrary paths (workspaces always come from
`listWorkspaces()`), a recents list, a persisted "last switched" setting
(VS Code already restores multi-root folder order on reload), and the
`claudeCode.claudeProcessWrapper` route.

## Tests

- `menus.test.mjs` needs nothing: no new `view/item/context` clause.
- Gap 2 is pure list logic; lift the `rest` computation into a function that
  takes `(folders, target, wsRoot)` and add one `node --test` case next to
  `terminal-pool.test.mjs`, same no-`vscode`-import split.
- Gap 1 and 3 are host behaviour: one line each in `MANUAL-CHECKLIST.md`.

## Side note

`~/.sandbox/config.yaml` holds the Jira API token in plain text. Any session
that `cat`s the config prints it into the transcript. Rotating it is cheap;
moving it to an env var or the keychain is a separate change.
