# Handoff: Stellwerk workspace card + tokens

Target repo: `jbbz-sandbox/werkmeister` (branch `main`). Rules, vocabulary and decisions: [`docs/ui-spec.md`](../../ui-spec.md); where this README and the spec disagree, the spec wins.

## Overview
This handoff covers a visual refresh of the workspace list across all four surfaces: the dashboard, the CLI pane, the VS Code tree and the MCP host. The core of it is a new **workspace card** with labelled rows and thin dividers. Status is shown with coloured dots instead of pills. The agent's question moves into an amber header, and buttons are sized consistently. The **token set** is also new: a warm off-white base, signal-blue accent, and Barlow + IBM Plex Mono type.

## About the design files
The `design/` files are **HTML design references, not production code**. They load React, fonts and codicons from public CDNs so they open in a browser; production bundles must not. Rebuild them in the repo:
- **Dashboard + MCP App:** as **React** components in `packages/sandbox-ui` (React is the UI library; see `docs/ui-spec.md` § Decisions). Until that package exists the card lives in `apps/sandbox-dashboard/src/workspace-ui.ts` (vanilla DOM via `el()` / `injectCss()`), which it replaces. React is bundled inline by `viteSingleFile`, so the Cowork artifact's CSP still holds; check it.
- **VS Code:** `packages/vscode-plugin/src/build-tree.ts` is a pure `WsNode` builder; it reads the shared display model, not React.
- **Pane:** `plugins/werkmeister/hooks/register.tsx` renders with Claude Code's own `Box`/`Text`/`Button`; it reads the shared display model, not React.
- **Tokens:** `packages/sandbox-ui` (today `apps/sandbox-dashboard/src/theme.ts`, `THEME_CSS`).

Open `design/*.dc.html` in a browser to see the designs. Sample data is in `design/data.js`.

## Fidelity
**High-fidelity.** Match colours, type, spacing and radii exactly.

---

## 1. Tokens (`theme.ts`)
Replace the `:root` block in `THEME_CSS` with `tokens.css`. The same values are in `tokens.json`.

Renames and removals:
- `--sd-ctl-border` → `--sd-ctl`
- `--sd-ok-border` → `--sd-ok-bd`
- `--sd-err-border` → `--sd-err-bd`
- `--sd-ok-dot` and `--sd-warn-dot` → use `--sd-ok` / `--sd-warn` for dot fill and `-bg` for the 3px halo
- `--sd-soft` → `--sd-hover`
- `--sd-ghost` → `--sd-faint`
- The hard-coded `#dd6b20`, `#fdf0e6`, `#c05621` (partial) and `#7642d6`, `#f0e9ff` (merged) become `warn` and `pr`

New tokens: `off`, `pr`, `warn-solid` / `on-warn-solid`, `attn-bg` / `attn-bd`, `on-accent`.

**Fonts:** bundles must stay self-contained (`viteSingleFile`, no CDN). Ship Barlow 400/500/600 and IBM Plex Mono 400/500/600 as woff2 (both are OFL) and inline them via `@font-face`. The system stacks in `tokens.css` are the fallback.

**Colour rules:**
- `accent` never carries status.
- Solid amber (`warn-solid`) appears **only** for "Needs you".
- Every fg/bg pair passes AA. Ratios are on board 09.

**Radii:** 3 tag · 4 badge/chip · 6 button · 8 menu · 10 card · 12 MCP shell.

**Spacing scale:** 4 6 8 10 12 14 16 20 24 32.

## 2. Workspace card (dashboard)
Reference: `design/Workspace Card.dc.html` (look `rows`). States are on `03 State Gallery`, anatomy on `02 Card Anatomy`.

This replaces the `.ws` / `.ws-head` / `.panel` structure in `workspace-ui.ts`. The card is **always expanded**: there's no caret and no left status rail. The chat panel and the Usage panel open from actions rather than being nested inside the card.

### Container
- Background `--sd-card`, border `1px solid --sd-line`, radius 10px, shadow `--sd-shadow-card`.
- Text: `--sd-sans`, 14px, line-height 1.45, `font-variant-numeric: tabular-nums`.
- Gap between cards is 12px.
- When `needs` is true: border `--sd-attn-bd` and shadow `--sd-shadow-card-attn`.

### Header
- Layout: `padding 16px 18px 14px`, column, gap 7px, `border-bottom 1px --sd-line-soft`.
- When `needs` is true: background `--sd-attn-bg`, border-bottom `--sd-attn-bd`, top radius 9px.

**Row 1**
- Workspace name: 600 15.5px, letter-spacing −0.01em, line-height 1.3, `overflow-wrap:anywhere`, `flex:1 1 220px`.
- Right-aligned, gap 6px:
  - **Agent chip:** height 22px, padding 0 8px, radius 4px, 600 12px. Tone comes from the agent state (table below).
  - **⚙ Autonomous** (only when autonomous): height 20px, padding 0 7px, `1px solid --sd-ctl`, 600 12px.

**Row 2** (gap 4px 8px, 13.5px)
- **Type tag:** mono 600 10.5px, line-height 1, uppercase, letter-spacing .08em, padding 4px 6px 3px, radius 3px, background `--sd-off-bg`, colour `--sd-muted`. Values: Bug, Feature, Task, Spike, Refactor, Incident.
- Then the issue title in `--sd-ink`, with `text-wrap:pretty`.

**Row 3**
- The issue ref (e.g. `owner/repo#143`) in mono 400 12px, `--sd-info`, underlined on hover. Clicking it calls `bridge.openLink(issueUrl)`.
- With no issue, show "no issue" in `--sd-faint`.

**Question block** (only when `needs` is true and a last question exists; margin-top 4px)
- Collapsed:
  - A full-width button, padding 8px 12px, radius 6px, background `--sd-card`, `1px solid --sd-attn-bd`, 13px.
  - Contents: "Last question" (600, `--sd-warn`), then the quoted question on one line with an ellipsis, then "Show ▾" (`--sd-muted`).
- Expanded:
  - Box padding 12px 14px 14px.
  - Meta line, 12px: "Last question" + time + "Hide ▴".
  - The question at 15px, line-height 1.5, margin 6px 0 12px.
  - The primary button.

### Body: label/value rows
- Grid: `92px minmax(0,1fr)`.
- Every row after the first has a `1px --sd-line-soft` top border.
- Label cell: padding 12px 0 12px 18px, mono 600 10.5px, line-height 20px, uppercase, letter-spacing .08em, `--sd-muted`.
- Value cell: padding 12px 18px 12px 12px, flex-wrap, `min-width:0`.

| Row | Value |
|---|---|
| CONTAINERS | Summary dot + text (`N of M up`, 600). Then one item per service, 13px: glyph + name, plus ` unhealthy` / ` starting` when relevant. The glyph is coloured by tone, the name is `--sd-muted` (tone colour if unhealthy or starting). If Docker can't be reached: "Docker unreachable · retry". |
| PRS | One line per PR, gap 4px 10px: the ref in mono 500 12.5px `--sd-info`, then the state badge, then CI (6px dot + text, 500 13px, tone colour). State badge: height 20px, padding 0 7px, radius 3px, 600 12px, tone fg/bg/bd; Draft uses a **dashed** border. No PRs: "None yet" (`--sd-muted`). Lookup failed: "PRs unavailable · retry" (`--sd-warn`). |
| WORKFLOW | Text at weight 500 (600 for lifecycle text such as "Ready to close out"). Staged workflows read `Stage n of m · name` and show stage pips on the right (20×6px, radius 2px, gap 3px): finished stages `--sd-ink`, the current stage `--sd-muted`, upcoming stages `--sd-line`. **No workflow-kind tag.** |
| AGENT | Dot + state word (600; `--sd-warn` when `needs`, otherwise `--sd-ink`), then the time, 13px `--sd-muted` (e.g. "asked a question 12 min ago"). |

**Status dots:** 8×8px circle, fill = tone fg, `box-shadow: 0 0 0 3px <tone bg>`.

### Footer: action bar
- Layout: padding 12px 18px, gap 8px, wrap, `border-top 1px --sd-line-soft`.
- **Primary button:**
  - Height 30px, padding 0 12px, radius 6px, 600 13px.
  - Background and border `--sd-accent`, text `--sd-on-accent`, shadow `--sd-shadow-btn-primary`.
  - If the primary action is **✓ Close out**, it uses the destructive style instead: background `--sd-err-bg`, colour and border `--sd-err`, no shadow.
- **Secondary buttons (2):**
  - Height 30px, padding 0 11px, 500 13px.
  - `1px --sd-ctl`, background `--sd-card`, shadow `--sd-shadow-btn`, hover `--sd-hover`.
- A spacer (`flex:1`), then the **⋯** button (30×30px). While its menu is open: background `--sd-hover`, border `--sd-ink`.
- **Overflow menu:**
  - Absolutely positioned, right 18px, `min-width 220px`, padding 5px, radius 8px, `--sd-shadow-menu`.
  - Items: padding 7px 10px, radius 5px, 13px.
  - Order: card-specific extras, a divider, `↻ Refresh PRs`, `Open feature ↗`, `Open issue ↗` (opacity .45 when there's no issue), `Logs`, a divider, then **✕ Abandon…** (`--sd-err`, 600, hover `--sd-err-bg`).

### Confirm states (they replace the footer inline, never as a modal)
- **Close out**
  - Footer: border-top `--sd-err-bd`, padding 14px 18px 16px.
  - Text: title "Close out {name}?" and the line "Moves the issue to Done, writes closeout.md, removes the workspace and deletes the merged branches."
  - Buttons: **✓ Yes, close out** (err-bg/err) and Cancel.
- **Abandon**
  - Footer background `--sd-err-bg`, border-top `--sd-err`.
  - Text: title "Abandon {name}?" in `--sd-err` and the line "Posts the reason on the issue and marks it abandoned, then removes the workspace. Every branch is pushed and kept."
  - A required **Reason** input (height 32px).
  - **✕ Yes, abandon** (solid `--sd-err`, white text) stays disabled at opacity .5 until the reason is non-empty. Then Cancel.
  - Calls `close-out` with `abandon` and the reason.

This replaces today's "Click again to confirm" double-click arming.

### Loading skeleton
- Show the name for real, with `--sd-line-soft` bars in place of the chip, tag and title.
- Each row label is real; its value is a bar plus the word "loading" (12px `--sd-faint`).
- Footer: bars of 160, 72, 72 and 30px.
- Set `aria-busy="true"`.

## 3. State mapping

| Agent state | Chip label | Chip fg/bg | Dot |
|---|---|---|---|
| needs | `● Needs you` | `on-warn-solid` / `warn-solid` | warn |
| working | `◌ Working` | ok | ok |
| done | `✓ Done` | ok | ok |
| idle | `Idle` | off | off |

`needs` comes from the agent-state signal added by jbbz-sandbox/werkmeister#243, **not** `claude.waiting`: that flag is true for every run whose transcript ends with assistant text, finished runs included, and would light the solid-amber chip on them.

- **Service glyphs:** up ● ok · down ○ off · starting ◐ warn · unhealthy ▲ err.
- **Container summary tone:** all up → ok · some up → warn · none up → off · unknown → off.
- **PR state tone:** Open → ok · Draft → off (dashed) · Merged and Released vX → pr · Closed → off.
- **CI:** pass `CI ✓` ok · running `CI running` warn · fail `CI ✗ N failing` err.

**Primary action by state** (the bar always shows the primary plus 2 secondaries; the rest go in the overflow menu):

| Situation | Primary | Secondaries |
|---|---|---|
| needs / working, containers up | `↗ Continue in {Desktop\|Terminal}` | `■ Stop`, `↻ Restart` |
| containers down | `↗ Continue…` or `▶ Up` | `▶ Up` / `＋ New session` |
| done + PR released | `✓ Close out` | `↻ Restart`, `⏻ Down` |

Full matrix: `design/06 Actions.dc.html`.

## 4. Other surfaces
- **Top bar and filter:** see `Dashboard View.dc.html`. It covers the infra, k8s and kube items restyled to the dot scale, the kube env pill using ok/warn/err/off tokens, and a "Needs you" filter toggle (solid amber when on).
- **VS Code tree** (`build-tree.ts`):
  - Keep the codicons.
  - Remap colours per board 09 §E: ok `charts.green`, warn `charts.yellow`, err `errorForeground`, off `disabledForeground`, pr `charts.purple`.
  - Prefix the description with the agent state, e.g. `● Needs you · 2 of 2 up · slot 3 · #143`. Every count names its unit.
  - Reference: `VSCode Tree.dc.html`.
- **Claude Code pane** (`plugins/werkmeister/hooks/register.tsx`):
  - Uses named colours (success/warning/error/inactive). It has no purple, so the words "Merged" and "Released" carry that state.
  - Reference: `Pane View.dc.html`.
- **Create form:** `Create Form.dc.html` / board 08, applied to `create-form.ts` (RJSF).

## 5. Acceptance checks
- [ ] No hex literals remain in `workspace-ui.ts` CSS; everything uses `--sd-*` tokens.
- [ ] Only a `needs` card has an amber border or header, and nothing else uses solid amber.
- [ ] Every text/background pair is ≥ 4.5:1 in both light and dark.
- [ ] Long names wrap and never push the chips off the card. Seven or more services wrap.
- [ ] Draft PRs have a dashed badge. "PRs unavailable" and "Docker unreachable" each offer a retry.
- [ ] Abandon can't be submitted with an empty reason.
- [ ] Bundles make no network font requests, and the Cowork artifact is still under the CSP.
- [ ] The existing `test/*.smoke.mjs` and `build-tree` tests pass, with tests updated for the new descriptions.

## Files
- `tokens.css`, `tokens.json`: the token values.
- `design/Workspace Card.dc.html`: the card component (source of truth).
- `design/data.js`: sample data and the display-model mapping (states → tones/labels).
- `design/0*-*.dc.html`: guide boards 01–09.
- `design/Dashboard View`, `Pane View`, `VSCode Tree`, `Create Form` `.dc.html`: one per surface.
- `design/Card Polish.dc.html`: light and dark comparisons.
- `design/support.js`: the runtime that lets the references open in a browser.
