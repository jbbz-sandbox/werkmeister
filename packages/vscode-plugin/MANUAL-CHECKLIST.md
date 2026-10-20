# Sandbox Workspaces — Manual Verification Checklist

The interactive checks that could not be automated, consolidated into one pass.
Work through Phase A first (Extension Development Host, no install required),
then Phase B (installed `.vsix`, real VS Code).

Each entry gives what to click, what should happen, and — where it isn't
obvious — what a failure looks like.

**Automated already — do not re-check by hand:**

| Covered by | What it asserts |
|---|---|
| `npm test` → `src/menus.test.mjs` | Which inline action appears on which node (start/stop state gating, switch hidden on the current workspace, the intercept toggle's three cases), that the card verbs (Continue, New session, PRs, Close out, Abandon) show on every workspace and on no service, PR or legend row, that no Remove action exists, and that `Logs` / `Open issue` / `Open PR` / `Toggle Intercept` stay out of the palette. Real `buildTree` nodes fed into the real `when` clauses from `package.json`. |
| `npm test` → `src/build-tree.test.mjs` | The tree against the design's sample data (`VSCode Tree.dc.html`): descriptions, agent icons and colours, PR rows, the Markdown tooltip's rows and command links, Markdown escaping, the board 09 tone map, the legend rows, plus service health, the `current` marker (multi-root included), top-sorting, node id stability. |
| `npm test` → `src/terminal-pool.test.mjs` | Terminal reuse: idle-only, per-cwd, closed terminals dropped. |
| `npm test` → `src/poll.test.mjs` | Visibility-gated polling (the retired step 6): a hidden view never ticks, going hidden stops it, returning refetches at once, a duplicate visible event starts no second interval, teardown releases both. |
| `npm run test:integration` → `src/test/extension.test.cjs` | Runs in a real extension host: every declared command is registered, a lifecycle command names its terminal `sandbox <workspace>`, `⚡ Connect infra` runs in a `sandbox connect` terminal, the config tier order — a `sandbox.*` setting overrides the inherited `SANDBOX_*`, and clearing it restores that value instead of deleting it — and that `Configure` actually opens the settings editor. |

What is left below needs a human: real container/Telepresence state, the visual
render, or a live editor.

---

## Phase A — Extension Development Host (F5)

1. **Launch the dev host.** Open `packages/vscode-plugin` in VS Code and press
   **F5**. A second VS Code window ("Extension Development Host") opens.

2. **Open the view.** Click the Sandbox icon in the activity bar to open the
   "Workspaces" view.

3. **Tree renders real data (SW-55 card spec).** Each workspace's icon follows
   its agent: yellow filled circle = Needs you, spinning green sync = Working,
   green check = Done, grey outline = Idle, question mark = no status. The
   description spells it out, e.g. `● Needs you · 2 of 2 up · stage 2/4 · SW-55`,
   and a stopped workspace reads `0 of N up` where a down one reads `down`.
   Expand a workspace: its services list with health icons (red ▲ for
   unhealthy), then one row per PR (`repo#N`, `Open · CI ✓`, purple merge
   icon once merged). Hover a workspace: a Markdown card with Containers / PRs /
   Workflow / Agent rows, `⚙ Autonomous` on an autonomous run, the agent's
   question as a quote, and three links that work (primary action, `→ Switch
   to`, `Open feature ↗`). Cross-check against `sandbox status` in a terminal —
   names, paths, and states should match.
   - Failure looks like: an empty tree with real workspaces running, or a tree
     showing dozens of raw repo checkouts instead of workspace names — see
     Phase B for the specific regression that indicates.

4. **CLI-not-found recovery.** If the view instead shows "Could not find the
   sandbox CLI": open Settings in the dev host and set `sandbox.root` (or
   `sandbox.binPath`). Confirm the tree recovers **without a window reload** —
   this exercises `onDidChangeConfiguration` → `applySettingsToEnv()` →
   `provider.refresh()`.

5. **↻ Refresh PRs.** Click `⟳` in the view's title bar (or right-click a
   workspace → `↻ Refresh PRs`). It re-runs the `gh` lookups; a PR opened since
   the last fetch appears as a child row. Click a PR row, or right-click a
   workspace → `Open PR ↗`, and the PR opens in the browser (a quick pick when
   the workspace has several).

5a. **Legend.** Click `?` in the title bar. A `Legend` group appears at the top
    with the four agent states, the service marks, Merged · Released and
    `⚙ Auto`, each in its colour. Click `?` again and it goes.

5b. **⚡ Connect infra.** Click `⚡` in the title bar. A `sandbox connect`
    terminal opens and starts shared infrastructure.

6. *Retired — visibility-gated polling is asserted in `src/poll.test.mjs`. The
   number is not reused: the notes cite these as stable ids.*

7. **Open in New Window.** Right-click a workspace → **Open in New Window**.
   The workspace opens in a new VS Code window (via native
   `vscode.openFolder`, not werkmeister-core's `openWorkspace()`).

7c. **↗ Continue in Terminal / ＋ New session.** Hover a workspace: the inline
    ↗ icon is first. Click it: a terminal `claude <workspace>` opens in the
    workspace folder running `claude --continue`. Right-click → `＋ New
    session`: another `claude <workspace>` terminal running `claude`.

7a. **Inline "switch workspace" icon.** Hover the same node; a → icon appears
    next to the ↗ icon. Click it. The workspace is added to *this* window as
    the **first** folder rather than opening a new window — folder 0 is what the
    Claude Code extension reads CLAUDE.md from. Click it on a workspace already
    open further down the folder list: it moves to the top, it is not duplicated.

7b. **Current workspace marker.** The workspace of this window's **first** open
    folder shows `current` first in its description, starts expanded, and is the
    **top row** whatever its alphabetical position. Open a multi-root
    `.code-workspace` where the sandbox workspace is *not* the first folder and
    confirm it is still marked — later folders count when the first matches no
    workspace.


8. **Open issue ↗.** Right-click a workspace with an issue ID → "Open
   issue ↗" opens the browser to that issue.

9. **Open Workspace from the palette.** Command Palette → "Sandbox: Open
   Workspace", with no tree node focused. It falls back to a QuickPick listing
   all workspaces (name, issue ID, path).

10. **Configure command — the filter only.** Palette → "Sandbox: Configure
    Sandbox CLI Path". That Settings *opens* is asserted in the host suite; what
    still needs eyes is that it is filtered to `sandbox.*` rather than opening
    the whole settings tree, which no API reports back.

11. **Lifecycle: Start.** Inline ▶ on a down workspace. A terminal named
    **`sandbox <workspace>`** opens running `sandbox up` in that workspace's
    directory; within ~5s (next poll) the description reads `N of N up`.

12. **Lifecycle: Stop.** Inline ⏸ on a running workspace. It reuses the same
    **`sandbox <workspace>`** terminal and the description reads `0 of N up`. (The *name* is
    asserted in the integration test; what needs eyes here is that the
    container state actually changes.)

13. **Lifecycle: Restart / Down.** Right-click → **Restart**, then → **Down**.
    Each runs in that workspace's terminal.

14. **One terminal per command — the fix for a real bug.** With a `logs`
    terminal still tailing (see step 15), click ▶ Up on any workspace.
    Confirm a **separate, newly created terminal** appears and `sandbox up`
    actually runs.
    - Failure looks like: nothing happens at all, no error, the tree never
      changes — the command was typed into the tailing process's stdin and
      swallowed. That was the pre-fix behaviour; it must not recur.

15. **Logs — scope.** Right-click **Logs** on a workspace node → terminal
    `sandbox logs <feature>` (tails everything). Right-click **Logs** on a
    service node → `sandbox logs <feature> <service>`. Confirm real log lines
    stream.


16. **New Workspace.** Click `+` in the view title. Enter an issue ID, or leave
    it empty, and press Enter. A terminal at `~` runs `sandbox workspace`
    (with `--issue-id <ref>` appended if you entered one). Press Escape on the
    input box instead and confirm **nothing** launches.

17. **Open feature ↗.** Right-click a running workspace → **Open feature ↗**.
    Spawns `sandbox open` detached — the one command that doesn't use a
    terminal, because it blocks for the lifetime of the browser window.

--- The remaining two are destructive. They change real state. Do them last. ---

18. **Toggle an intercept (mutates real Telepresence state).** Click `⇄` on an
    interceptable service. A terminal runs `sandbox intercept -s <service>`;
    afterwards the description reads "intercepted (yours)". Click `⇄` again —
    it now sends `--leave` and the intercept clears. This reroutes real traffic
    to your machine; only do it on a service you're prepared to reroute.

19. **✓ Close out / ✕ Abandon… (destroys the workspace directory).** There is
    no Remove action.
    - Right-click a workspace whose PRs are not all shipped → **✓ Close out**.
      A warning says it is not shipped and offers **✕ Abandon…**; dismiss it
      and nothing happens.
    - Right-click it → **✕ Abandon…**. An input box asks why. Press Escape:
      nothing happens. Give a reason: the modal reads **Abandon** and says
      every branch is pushed and kept. Click **Cancel**: nothing happens.
    - On a shipped workspace, **✓ Close out** shows no input box; the modal
      reads **Close out**.
    - Then on a workspace you do intend to end, confirm. A **progress
      notification** appears for the duration (it commits and pushes every
      worktree, runs `sandbox down`, then deletes — it can take minutes), an
      information message names the path and says to archive its desktop
      sessions, the "Sandbox Workspaces" output channel holds the close-out
      output, and the tree refreshes.
    - To exercise the failure path deliberately, make one worktree unpushable
      first (e.g. point its remote at a URL you can't write to). Confirm the
      delete is **aborted**, the workspace still exists, and the multi-line
      handoff report naming the failing branch appears in the **"Sandbox
      Workspaces" output channel** — not truncated into a toast.

---

## Phase B — Installed `.vsix`

20. **Install into the real VS Code.**
    ```bash
    cd packages/vscode-plugin && npm run package && code --install-extension werkmeister-vscode-0.1.0.vsix
    ```
    Deliberately not run during implementation — it modifies your live editor.

21. **Dock-launched, no shell environment — the check the config tier exists
    for.** Quit VS Code entirely, then relaunch **from the Dock or Finder, not
    `code .`**, so it inherits no shell environment (no `SANDBOX_ROOT`, no
    `SANDBOX_WORKSPACES_ROOT`). Open the Sandbox view with **no**
    `sandbox.root` / `sandbox.binPath` set.

    Expected: the same workspaces `sandbox status` shows.

    Failure looks like either:
    - **Dozens of raw repo checkouts** instead of named workspaces —
      `resolveWorkspacesRoot`'s config-file tier regressed and it fell back to
      `~/workspace`, which is the *repos* root.
    - **The "Could not find the sandbox CLI" node** — werkmeister-core couldn't
      resolve the binary from `~/.sandbox/config.yaml` with no env present.

    Diagnose against werkmeister-core directly, bypassing the extension:
    ```bash
    env -u SANDBOX_WORKSPACES_ROOT -u SANDBOX_ROOT node -e '
      const m = await import("/path/to/sandbox/packages/sandbox-core/dist/sandbox.js");
      console.log((await m.listWorkspaces()).root);
    ' --input-type=module
    ```
    The printed `root` should be your `paths.workspaces_root`, not your
    monorepo checkout.

---

**Total: 25 checks** (23 in Phase A, 2 in Phase B) — the rest are automated;
see the table at the top.
