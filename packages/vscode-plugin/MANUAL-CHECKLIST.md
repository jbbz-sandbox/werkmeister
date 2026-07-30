# Sandbox Workspaces — Manual Verification Checklist

The interactive checks that could not be automated, consolidated into one pass.
Work through Phase A first (Extension Development Host, no install required),
then Phase B (installed `.vsix`, real VS Code).

Each entry gives what to click, what should happen, and — where it isn't
obvious — what a failure looks like.

---

## Phase A — Extension Development Host (F5)

1. **Launch the dev host.** Open `apps/vscode-sandbox` in VS Code and press
   **F5**. A second VS Code window ("Extension Development Host") opens.

2. **Open the view.** Click the Sandbox icon in the activity bar to open the
   "Workspaces" view.

3. **Tree renders real data.** Confirm real workspaces are listed with state
   icons: green filled circle = up, yellow = partial, outline = stopped/down,
   question mark = unknown. Expand a running workspace and confirm its
   services are listed with their own health icons. Cross-check against
   `sandbox status` in a terminal — names, paths, and states should match.
   - Failure looks like: an empty tree with real workspaces running, or a tree
     showing dozens of raw repo checkouts instead of workspace names — see
     Phase B for the specific regression that indicates.

4. **CLI-not-found recovery.** If the view instead shows "Could not find the
   sandbox CLI": open Settings in the dev host and set `sandbox.root` (or
   `sandbox.binPath`). Confirm the tree recovers **without a window reload** —
   this exercises `onDidChangeConfiguration` → `applySettingsToEnv()` →
   `provider.refresh()`.

5. **Refresh button.** Click `⟳` in the view's title bar. Confirm it re-fetches
   without error (no visible change is expected if nothing changed underneath).

6. **Visibility-gated polling.** Switch to another activity-bar icon, wait a few
   seconds, switch back. There's no direct UI signal — eyeball it with a
   temporary `console.log` in `bind()` (`src/tree.ts`) if you want proof. The
   behaviour: the 5s poll stops while hidden and resumes when shown, rather
   than running unconditionally in the background.

7. **Inline "open workspace" icon.** Hover a workspace node; a folder icon
   appears inline. Click it. The workspace opens in a new VS Code window (via
   native `vscode.openFolder`, not the driver's `openWorkspace()`).

8. **Open Jira Issue (context menu only).** Right-click a workspace with a Jira
   ID → "Open Jira Issue" opens the browser to that issue. Then check the
   Command Palette for "Open Jira" — it must **NOT** appear (needs a tree node).

9. **Open Workspace from the palette.** Command Palette → "Sandbox: Open
   Workspace", with no tree node focused. It falls back to a QuickPick listing
   all workspaces (name, Jira ID, path).

10. **Configure command.** Palette → "Sandbox: Configure Sandbox CLI Path".
    Opens Settings filtered to `sandbox.*`.

11. **Lifecycle: Start.** Inline ▶ on a down workspace. A terminal named
    **`sandbox up <workspace>`** opens running `sandbox up` in that workspace's
    directory; within ~5s (next poll) the icon turns green.

12. **Lifecycle: Stop.** Inline ⏸ on a running workspace. Terminal
    `sandbox stop <workspace>`; icon goes grey.

13. **Lifecycle: Restart / Down.** Right-click → **Restart**, then → **Down**.
    Each opens its own named terminal running the matching subcommand.

14. **One terminal per command — the fix for a real bug.** With a `logs`
    terminal still tailing (see step 15), click ▶ Start on any workspace.
    Confirm a **separate, newly created terminal** appears and `sandbox up`
    actually runs.
    - Failure looks like: nothing happens at all, no error, the tree never
      changes — the command was typed into the tailing process's stdin and
      swallowed. That was the pre-fix behaviour; it must not recur.

15. **Logs — scope, terminal naming, palette omission.** Right-click **Logs**
    on a workspace node → terminal `sandbox logs <feature>` (tails everything).
    Right-click **Logs** on a service node → `sandbox logs <feature> <service>`.
    Then check the Command Palette for "Sandbox: Logs" — it must **NOT** appear.
    Logs is reachable only by right-clicking a node, because the feature name
    is only knowable from the tree.

16. **Intercept toggle visibility.** Expand a running workspace. The `⇄` inline
    toggle appears **only** on interceptable services and on ones you already
    intercept — never on a service intercepted by another feature (its
    `--leave` would fail; only one intercept exists per Deployment).

17. **New Workspace.** Click `+` in the view title. Enter a Jira ref, or leave
    it empty, and press Enter. A terminal at `~` runs `sandbox workspace`
    (with `--jira-id <ref>` appended if you entered one). Press Escape on the
    input box instead and confirm **nothing** launches.

18. **Open in Browser.** Right-click a running workspace → **Open in Browser**.
    Spawns `sandbox open` detached — the one command that doesn't use a
    terminal, because it blocks for the lifetime of the browser window.

--- The remaining two are destructive. They change real state. Do them last. ---

19. **Toggle an intercept (mutates real Telepresence state).** Click `⇄` on an
    interceptable service. A terminal runs `sandbox intercept -s <service>`;
    afterwards the description reads "intercepted (yours)". Click `⇄` again —
    it now sends `--leave` and the intercept clears. This reroutes real traffic
    to your machine; only do it on a service you're prepared to reroute.

20. **Remove Workspace (destroys the workspace directory).** Right-click a
    workspace you are willing to lose → **Remove Workspace...**.
    - Confirm the modal names the workspace and its detail reads: *"Commits and
      pushes every branch first — the delete is aborted if any push fails. Then
      tears down containers, deletes `<path>`, and prunes the worktrees."* It
      must **not** warn about losing unpushed commits — it doesn't lose them.
    - Click **Cancel**. Nothing happens.
    - Then on a workspace you do intend to remove, click **Remove**. Confirm a
      **progress notification** appears for the duration (this call commits and
      pushes every worktree, runs `sandbox down`, then deletes — it can take
      minutes), an information message names the removed path on success, and
      the tree refreshes.
    - To exercise the failure path deliberately, make one worktree unpushable
      first (e.g. point its remote at a URL you can't write to). Confirm the
      delete is **aborted**, the workspace still exists, and the multi-line
      handoff report naming the failing branch appears in a **"Sandbox
      Workspaces" output channel** — not truncated into a toast.

---

## Phase B — Installed `.vsix`

21. **Install into the real VS Code.**
    ```bash
    cd apps/vscode-sandbox && code --install-extension sandbox-workspaces-0.1.0.vsix
    ```
    Deliberately not run during implementation — it modifies your live editor.

22. **Dock-launched, no shell environment — the check the config tier exists
    for.** Quit VS Code entirely, then relaunch **from the Dock or Finder, not
    `code .`**, so it inherits no shell environment (no `SANDBOX_ROOT`, no
    `SANDBOX_WORKSPACES_ROOT`). Open the Sandbox view with **no**
    `sandbox.root` / `sandbox.binPath` set.

    Expected: the same workspaces `sandbox status` shows.

    Failure looks like either:
    - **Dozens of raw repo checkouts** instead of named workspaces —
      `resolveWorkspacesRoot`'s config-file tier regressed and it fell back to
      `~/workspace`, which is the *repos* root.
    - **The "Could not find the sandbox CLI" node** — the driver couldn't
      resolve the binary from `~/.sandbox/config.yaml` with no env present.

    Diagnose against the driver directly, bypassing the extension:
    ```bash
    env -u SANDBOX_WORKSPACES_ROOT -u SANDBOX_ROOT node -e '
      const m = await import("/Users/jayboyer/workspace/personal-work/packages/sandbox-driver/dist/sandbox.js");
      console.log((await m.listWorkspaces()).root);
    ' --input-type=module
    ```
    The printed `root` should be your `paths.workspaces_root`, not your
    monorepo checkout.

23. **Shell-launched, env present — the other half of the tier order.** Quit
    VS Code, then launch it with `code .` from a shell where `~/.zshenv` has
    sourced `~/.sandbox/env.sh` (check with `echo $SANDBOX_ROOT` first — it
    must be non-empty). Leave `sandbox.binPath` and `sandbox.root` **empty** in
    Settings.

    Expected: the tree still lists the correct workspaces, driven by the
    inherited `SANDBOX_ROOT` rather than the config file.

    Failure looks like: the tree works but drives the *wrong checkout* — e.g.
    lifecycle commands run against a different repo than the one your shell
    pointed at. The extension writes settings into `process.env` at activation,
    and a blank setting must **restore** the inherited value, never delete it.
    Verify with:
    ```
    Command Palette → Developer: Toggle Developer Tools → Console
    ```
    then check that `SANDBOX_ROOT` still matches your shell's value.

---

**Total: 23 checks** (20 in Phase A, 3 in Phase B).
