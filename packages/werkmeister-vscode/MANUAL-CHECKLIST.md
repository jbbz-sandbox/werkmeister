# Werkmeister Workspaces — Manual Verification Checklist

The interactive checks that could not be automated, consolidated into one pass.
Work through Phase A first (Extension Development Host, no install required),
then Phase B (installed `.vsix`, real VS Code).

Each entry gives what to click, what should happen, and — where it isn't
obvious — what a failure looks like.

**Automated already — do not re-check by hand:**

| Covered by | What it asserts |
|---|---|
| `pnpm test` → `src/menus.test.mjs` | Which inline action appears on which node (start/stop state gating, switch hidden on the current workspace, the intercept toggle's three cases), that the card verbs (Continue, New session, PRs, Close out, Abandon) show on every workspace and on no service, PR or legend row, that no Remove action exists, and that `Logs` / `Open issue` / `Open PR` / `Toggle Intercept` stay out of the palette. Real `buildTree` nodes fed into the real `when` clauses from `package.json`. |
| `pnpm test` → `src/build-tree.test.mjs` | The tree against the design's sample data (`VSCode Tree.dc.html`): descriptions, agent icons and colours, PR rows, the Markdown tooltip's rows and command links, Markdown escaping, the board 09 tone map, the legend rows, plus service health, the `current` marker (multi-root included), top-sorting, node id stability. |
| `pnpm test` → `src/cards.test.mjs` | The stages bar (SW-961): one segment per stage under the meta line, done / current / next classes, `aria-valuenow` = done and `aria-valuemax` = total, and no bar on a JIT or unstaged workspace. |
| `pnpm test` → `src/terminal-pool.test.mjs` | Terminal reuse: idle-only, per-cwd, closed terminals dropped. |
| `pnpm test` → `src/poll.test.mjs` | Visibility-gated polling (the retired step 6): a hidden view never ticks, going hidden stops it, returning refetches at once, a duplicate visible event starts no second interval, teardown releases both. |
| `pnpm run test:integration` → `src/test/extension.test.cjs` | Runs in a real extension host: every declared command is registered, a lifecycle command names its terminal `werkmeister <workspace>`, `⚡ Connect infra` runs in a `werkmeister infra connect` terminal, the config tier order — a `sandbox.*` setting overrides the inherited `WERKMEISTER_*`, and clearing it restores that value instead of deleting it — and that `Configure` actually opens the settings editor. | <!-- name-check: ignore -->

What is left below needs a human: real container/Telepresence state, the visual
render, or a live editor.

---

## Phase A — Extension Development Host (F5)

**Agents, and any check that presses a button: use the fixture dev host, never F5 (SW-1020).**
F5 opens the dev host against your real daemon and `~/.werkmeister`, where Up, Stop,
Restart, Close out and the session terminals act on real workspaces. After
`pnpm --filter werkmeister-vscode run build`, run on the host:
`node packages/werkmeister-vscode/scripts/manual-dev-host.mjs [busy|quiet]`.
Its window shows the SW-1019 snapshot fixture's cards from a fake daemon; HOME,
the workspaces root, `--user-data-dir` and `--extensions-dir` are temp, and the CLI
is a stub, so a press reaches nothing real. Close the window: the script prints every
daemon and CLI call the presses made, then deletes its temp folder. Steps that need
real containers or Telepresence still need F5 by a person.

1. **Launch the dev host.** Open `packages/werkmeister-vscode` in VS Code and press
   **F5**. A second VS Code window ("Extension Development Host") opens.

2. **Open the view.** Click the Werkmeister icon in the activity bar to open the
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
   to`, `Open feature ↗`). Cross-check against `werkmeister feature status` in a terminal —
   names, paths, and states should match.
   - Failure looks like: an empty tree with real workspaces running, or a tree
     showing dozens of raw repo checkouts instead of workspace names — see
     Phase B for the specific regression that indicates.

3a. **Stages bar (SW-961).** A staged workspace's card has a full-width bar
    under its meta line, one equal segment per `stages/NN_*` folder: the done
    stages blue, the current one a paler blue, the rest a faint track, like the
    segmented bar on a GitHub Actions job card. Hover it: `1 of 4 stages done`.
    A JIT or unstaged workspace, and one whose card shows a PR or ship step,
    has no bar. Check it in a dark and a light theme.

4. **CLI-not-found recovery.** If the view instead shows "Could not find the
   werkmeister CLI": open Settings in the dev host and set `sandbox.root` (or
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

5b. **⚡ Connect infra.** Click `⚡` in the title bar. A `werkmeister infra connect`
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
    `.code-workspace` where the workspace is *not* the first folder and
    confirm it is still marked — later folders count when the first matches no
    workspace.


8. **Open issue ↗.** Right-click a workspace with an issue ID → "Open
   issue ↗" opens the browser to that issue.

9. **Open Workspace from the palette.** Command Palette → "Werkmeister: Open in
   New Window", with no tree node focused. It falls back to a QuickPick listing
   all workspaces (name, issue ID, path).

10. **Configure command — the filter only.** Palette → "Werkmeister: Configure
    Werkmeister CLI Path". That Settings *opens* is asserted in the host suite; what
    still needs eyes is that it is filtered to `sandbox.*` rather than opening <!-- name-check: ignore -->
    the whole settings tree, which no API reports back.

11. **Lifecycle: Start.** Inline ▶ on a down workspace. `werkmeister feature up` runs as a
    task in the shared task panel, which does not take focus; the view refreshes when it
    ends and the description reads `N of N up`.

12. **Lifecycle: Stop.** Inline ⏸ on a running workspace. It runs in the same task panel
    and the description reads `0 of N up`. (One panel and the exit codes are asserted in
    the integration test; what needs eyes here is that the container state actually
    changes.)

13. **Lifecycle: Restart / Down.** Right-click → **Restart**: a silent task. Then → **Down**
    on a workspace with an open decision note: the panel comes forward with focus at the
    `Graduate …? [g/s]` prompt, and a key you type answers it.

14. **A failing command comes forward (SW-979).** Set the CLI path setting to a script
    that exits 1, then click ▶ Up: the task panel comes forward with its output. With the
    real CLI, run Up, Stop and Restart on three workspaces: at most one werkmeister task
    terminal is open afterwards, and with `terminal.integrated.shellIntegration.enabled`
    off the same holds.

15. **Logs — scope.** Right-click **Logs** on a workspace node → terminal
    `logs <feature>` (tails everything). Right-click **Logs** on a
    service node → `logs <service>`, that service only. Confirm real log lines
    stream.


16. **New Workspace.** Click `+` in the view title. A terminal at the
    workspaces root runs `werkmeister workspace new`, and the CLI's own wizard prompts
    (issue ID included).

17. **Open feature ↗.** Right-click a running workspace → **Open feature ↗**.
    Spawns `werkmeister feature open` detached — the one command that doesn't use a
    terminal, because it blocks for the lifetime of the browser window.

--- The remaining two are destructive. They change real state. Do them last. ---

18. **Toggle an intercept (mutates real Telepresence state).** Click `⇄` on an
    interceptable service. A terminal runs `werkmeister infra intercept -s <service>`;
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
      worktree, runs `werkmeister feature down`, then deletes — it can take minutes), an
      information message names the path and says to archive its desktop
      sessions, the "Werkmeister Workspaces" output channel holds the close-out
      output, and the tree refreshes.
    - To exercise the failure path deliberately, make one worktree unpushable
      first (e.g. point its remote at a URL you can't write to). Confirm the
      delete is **aborted**, the workspace still exists, and the multi-line
      handoff report naming the failing branch appears in the **"Werkmeister
      Workspaces" output channel** — not truncated into a toast.

---

## Phase B — Installed `.vsix`

20. **Install into the real VS Code.**
    ```bash
    cd packages/werkmeister-vscode && pnpm run build && pnpm run package --out werkmeister-vscode.vsix && code --install-extension werkmeister-vscode.vsix
    ```
    Deliberately not run during implementation — it modifies your live editor.

21. **Dock-launched, no shell environment — the check the config tier exists
    for.** Quit VS Code entirely, then relaunch **from the Dock or Finder, not
    `code .`**, so it inherits no shell environment (no `WERKMEISTER_ROOT`, no
    `WERKMEISTER_WORKSPACES_ROOT`). Open the Werkmeister view with **no**
    `sandbox.root` / `sandbox.binPath` set.

    Expected: the same workspaces `werkmeister feature status` shows.

    Failure looks like either:
    - **Dozens of raw repo checkouts** instead of named workspaces —
      `resolveWorkspacesRoot`'s config-file tier regressed and it fell back to
      `~/workspace`, which is the *repos* root.
    - **The "Could not find the werkmeister CLI" node** — werkmeister-core couldn't
      resolve the binary from `~/.werkmeister/config.yaml` with no env present.

    Diagnose against werkmeister-core directly, bypassing the extension:
    ```bash
    env -u WERKMEISTER_WORKSPACES_ROOT -u WERKMEISTER_ROOT node -e '
      const m = await import("/path/to/werkmeister/packages/werkmeister-core/dist/sandbox.js");
      console.log((await m.listWorkspaces()).root);
    ' --input-type=module
    ```
    The printed `root` should be your `paths.workspaces_root`, not your
    monorepo checkout.

---

**Total: 25 checks** (23 in Phase A, 2 in Phase B) — the rest are automated;
see the table at the top.

## Cards (webview)

The view is a webview of wrapping cards since the tree was replaced, so the steps above that say
"hover a workspace" or "inline icon" now mean the card's right-click menu, and "expand" means nothing:
a card always shows its services and PRs.

- **Wrapping.** Drag the side bar to its narrowest: every line wraps, nothing ends in `…`.
- **Theme.** Switch between a dark, a light and a high-contrast theme: the cards follow at once.
- **Links.** The workspace name is the issue link: hover it and the tooltip reads `Open SW-… in Jira`
  (GitHub for a GitHub issue); click it and the issue opens. There is no separate issue line. Each PR sits
  on its own line and opens on click. A PR's state is green when open, purple when merged, blue when
  released, and failing checks read red.
- **Line order (SW-864).** Line 1 is the name and state, line 2 the model and stage
  (`opus · spike · stage 1/2 questions`), then the activity.
- **Right-click.** On a card: Open in New Window, the container commands, Open feature, Logs, Close out
  and Abandon, with ▶ Up / ■ Stop only
  where they apply. On a service: Logs, and Toggle Intercept where it is interceptable or yours.
- **Open terminal.** Click it on a workspace with no session terminal: one opens running
  `claude --continue`, its tab named `SW-864 · vscode-ui-revamp` (issue key first). Click it again: the
  same terminal takes focus, no second one opens. A `claude <workspace>` tab left open from before
  SW-864 is focused too. A Needs-you card's button is the primary-coloured **Answer in terminal**.
- **Start work / Pause / Resume.** These act on the run, not on containers. A workspace nobody has
  started has ▶ Start work beside Open terminal: click it and a `claude <workspace>` terminal opens
  with the starting prompt already sent. A live run has ⏸ Pause, which holds the session and freezes
  its containers, and becomes ▶ Resume once the workspace reads Paused.
- **Status strip (SW-1009).** At the default side bar width (about 300px) the top of the view is one strip
  of at most 2 rows: chips such as `● 2 need you · 12 min`, `1 running` or `infra: caddy down` (only those
  above zero), then `host 32% · features 0.5 of 10 cores` with a two-tone meter. Hover the host text: the
  tooltip shows the 1 · 5 · 15 min load. Scroll the cards: the strip stays pinned on the side bar background.
  Click a chip: the view scrolls to the first card it counts. Drag the side bar under 260px: the meter hides,
  the text stays. With a workspace waiting on you, the view's icon in the activity bar carries that count.
- **Foreman (title bar).** With a chat already running in a terminal at the workspaces root, click the
  terminal icon in the view title: that terminal takes focus. Close it and click again: a `Foreman` terminal
  opens there with the circuit-board icon. A `Master control` terminal left open from before is focused too.
- **Jira board (title bar).** With no `board:` under the default project in `~/.werkmeister/config.yaml`,
  there is no board icon. Add `board: { id: 1, ready: … }` and wait 5 s: the icon shows, and clicking it opens
  the SW board. Refresh PRs, Connect infra, Legend, Detect and Sync registry are under the title's `…` menu.
- **In-terminal cue (SW-864).** Open two workspaces' terminals. Click each terminal tab in turn: the card
  for that tab gets the blue border and the `In terminal` pill at once, with no 5 s wait, and no other card
  has it; the Foreman terminal cues no card. Open a plain shell outside the workspaces
  (Terminal → New Terminal from `~`) or click a `werkmeister …` command terminal: no tile has the cue.
  Close the active terminal: the cue follows whichever terminal VS Code shows next. Repeat in a light and
  a high-contrast theme: the border and pill stay visible.
- **Dashboard (title bar).** With the dashboard running, click its icon in the view title: the dashboard opens in the browser. With it
  stopped: a notice offers ⚡ Connect infra.
- **Hide waiting on release (SW-1003).** With a merged workspace whose PR no release has yet, click the eye in
  the view title: its card goes, the eye flips, and the strip reads `1 hidden · waiting on release`.
  Wait 10 s: it stays hidden across the 5 s redraws. Reload the window (Developer: Reload Window): the eye is
  still crossed and the card still hidden. Click `1 hidden · waiting on release` or the eye: the card is back.
