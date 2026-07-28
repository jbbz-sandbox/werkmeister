# Design — Claudeck "Create Workspace" in the Add Project modal

**Date:** 2026-07-24
**Branch:** `claudeck`
**Status:** Approved design; ready for implementation planning.

## Problem

Claudeck can *view* a sandbox feature workspace (the project-scoped Workspace tab)
and *open* an existing folder as a project (the Add Project modal), but there is
no way to **create** a new sandbox workspace from the UI. Creating one is more
involved than adding a simple project: it collects ~11 inputs, creates git
worktrees on a `<user>/<workspace>` branch, and runs `init-workspace`.

Creating a workspace is a **project-layer** action, not a right-panel-tab
concern. So the create UI extends the existing **Add Project** modal rather than
living in a tab.

## Key facts (grounding)

- `sandbox workspace --print-form-schema` emits a render-ready RJSF bundle
  (`{ schema, uiSchema, formData, title }`) — the **single source of truth** for
  the form. Fields are flat (no nesting/conditionals), 11 total, with validation
  `pattern`/`required`/`minLength` baked in. Required: `feature`, `work_type`.
- The rich extras (Jira pre-fill, AI prompt refine) exist **only in
  `packages/sandbox-driver`** (`fetchJiraFormData`, `refinePrompt`), which shell
  out to the `claude` CLI. The `sandbox` CLI does **not** expose them. So the
  rich flow **requires the driver** — a self-contained re-implementation would
  duplicate hundreds of lines of LLM/Jira/cache/security logic.
- The React `sandbox-dashboard` already renders this form via RJSF + the driver.
  Claudeck is **vanilla JS**, so it renders the schema with a small vanilla
  renderer instead of RJSF.
- Claudeck internals used by this feature:
  - Add Project modal: core custom element `<claudeck-add-project>` in
    `public/js/components/add-project-modal.js`; folder-browser logic in
    `public/js/features/projects.js`. Modal shows/hides via `.hidden`.
  - Projects are added with `api.addProject(name, path)` then `loadProjects()`
    reloads `$.projectSelect`. Reused as-is post-create.
  - Plugin **server routes** mount at `/api/plugins/<name>/`
    (`server/plugin-mount.js`); `express.json()` is global, so POST bodies work.

## Architecture

Extend the core Add Project modal into a **two-tab modal**:

```
╔═ Add Project ═════════════════════════════╗
║ [ Open Folder ]  [ Create Workspace ]     ║  ← tab bar (new)
║───────────────────────────────────────────║
║  Open Folder = today's directory finder,  ║
║               UNCHANGED.                   ║
║  Create Workspace = schema-driven form.    ║
╚═══════════════════════════════════════════╝
```

Both tabs converge on the same outcome: a project added to the picker and
selected. That shared endpoint is why they belong in one modal.

### Component split

| Piece | Location | Rationale |
|---|---|---|
| Tabbed modal shell + tab switch | **Core** — `add-project-modal.js`, `projects.js` | Only core owns the project-picker modal |
| Create-workspace form renderer + Jira/Refine buttons | **Plugin** — `plugins/sandbox-workspace/create-form.mjs`, dynamically imported by the modal on first Create-tab open | Keeps all workspace logic + driver coupling isolated to the plugin; core edit stays minimal (tab bar + mount point) |
| Server routes: `form-schema`, `jira-form-data`, `refine-prompt`, `create` | **Plugin** — `plugins/sandbox-workspace/server.js` | Already the mount point; driver-backed |
| `sandbox-driver` dependency | **Plugin only** (`apps/claudeck` package via the plugin) | Rich flow requires it; isolating to the plugin keeps vendored core driver-free |

### Accepted trade-offs

1. **Edits vendored core** (`add-project-modal.js` + `projects.js`), reversing the
   "no core edits" rule held for the Workspace tab plugin. Unavoidable once we
   extend the core modal. Kept minimal (tab bar + mount point; the form is
   plugin code loaded on demand) and **documented in `VENDORED.md`** so upstream
   re-syncs account for it.
2. **`sandbox-driver` must be built** (`tsc` → `dist/`) before claudeck runs.
   Claudeck's plugin server currently has zero build-step deps; this adds one.
   Accepted over re-implementing Jira/refine self-contained.

## Form rendering

`create-form.mjs` maps the RJSF bundle to DOM (~100 lines; the schema is flat
with 4 widget shapes):

| Schema signal | Rendered as |
|---|---|
| `type: string` | `<input type="text">` + `pattern` / `required` / `placeholder` |
| `type: string` + `enum` | `<select>` |
| `type: array` + `items.enum` + `ui:widget: checkboxes` | checkbox group |
| `ui:widget: textarea` | `<textarea>` |

- **Native validation:** schema `pattern`/`required` → HTML5 `pattern`/`required`
  attributes; the browser blocks a bad `feature` or missing `work_type` before
  submit. No hand-rolled validators.
- Field order from `uiSchema["ui:order"]`.
- **Schema-driven affordances** (not hardcoded):
  - `jira_id` field present → render a **"Fetch from Jira"** button.
  - any field with `ui:options.refinable` → render a **"Refine ✨"** button
    carrying its `refineInstruction` (today only `starting_prompt`; future
    refinable fields light up automatically).
- All server/CLI/Jira output is untrusted → DOM via `textContent`/`createElement`,
  never `innerHTML` interpolation (same rule as the rest of the plugin).

## Data flow (4 plugin routes, all driver-backed)

```
Create Workspace tab opened
   └─ GET /form-schema ─────────────→ getFormSchema()            → render form
"Fetch from Jira" (jira_id filled)
   └─ POST /jira-form-data {ref} ───→ fetchJiraFormData(ref)     → merge into fields
"Refine ✨" on a refinable field
   └─ POST /refine-prompt {text,instruction,formData} → refinePrompt() → replace field
"Create →"
   └─ POST /create {formData} ──────→ createWorkspace(formData, { open:false, onData })
        onData chunks → res.write → live <pre> in the modal (chunked text/plain)
        └─ driver returns { workspacePath } → api.addProject(name, path)
                        → loadProjects() → select it → close modal
```

- `/create` streams via a **new optional `onData` callback on the driver's
  `createWorkspace`/`runSandbox`** (see "Driver change" below), so create output
  renders live *and* the driver still parses+returns `workspacePath` — no
  duplicated path parser. Response is chunked `text/plain` terminating `[exit N]`,
  matching the existing `/action` route.
- `open: false` → no VS Code launch; claudeck selects the new project instead.
- Post-create reuses `addProject` + `loadProjects` — no separate `folders.json`
  sync. New workspace lands in the picker, auto-selected; user drops into it.

### Driver change (additive, backward-compatible)

`packages/sandbox-driver/sandbox.ts` gains an optional streaming callback:

- `runSandbox(args, { cwd, onData })` — when `onData` is provided, run via
  `spawn` and forward each stdout/stderr chunk to `onData` while accumulating the
  same `{ stdout, stderr }` it returns today; when absent, keep the existing
  `execFileAsync` (buffered) path **unchanged**, so every current caller
  (dashboard `createWorkspace`, `listWorkspaces`, …) is untouched.
- `createWorkspace(formData, { open, onData })` — passes `onData` through; still
  runs `parseWorkspacePath` on the complete output and returns `CreateResult`.

This is the single point of reuse that lets the plugin stream without porting the
private `parseWorkspacePath`.

## Error handling / degradation

- **Plugin disabled / driver not built** → `/form-schema` fails → Create tab
  shows *"Enable the Sandbox Workspace plugin (and build sandbox-driver)."* The
  **Open Folder tab always works** — the directory finder depends on none of this.
- **Jira-fetch / Refine best-effort** (driver already degrades): button shows a
  spinner; on failure, a toast and fields left untouched. Never blocks Create.
- **Create failure** (non-zero `[exit N]`): modal stays open with streamed output
  visible; nothing added to the picker.
- **Feature-name collision** (already exists): surfaced from the CLI's own stream
  output; not pre-checked.

## Testing

- **Pure units** (`node --test`): schema→field-descriptor mapper (plugin). The
  driver's Jira/refine/argv/path-parse logic is owned and tested upstream — not
  re-tested here.
- **Driver change**: a focused test that `runSandbox`/`createWorkspace` with
  `onData` forwards chunks and returns the same shape as the buffered path.
- **Live acceptance**: open modal → Create Workspace → enter `feature` +
  `work_type` → Create → new workspace appears selected in the picker. Plus one
  Jira-fetch and one Refine round-trip.

## Files touched (anticipated)

**Core (vendored — minimal edits, documented in `VENDORED.md`):**
- `apps/claudeck/public/js/components/add-project-modal.js` — tab bar + two panels
  (Open Folder wraps existing markup; Create Workspace = mount point).
- `apps/claudeck/public/js/features/projects.js` — tab switch; lazy dynamic
  import of `create-form.mjs`; post-create `addProject`/`loadProjects` glue.
- `apps/claudeck/public/css/…` (or the modal's stylesheet) — tab + form styles.

**Plugin (`apps/claudeck/plugins/sandbox-workspace/`):**
- `create-form.mjs` — vanilla schema-driven form renderer + Jira/Refine buttons.
- `parse-form-schema.mjs` (+ `.test.mjs`) — pure schema→field-descriptor mapper.
- `server.js` — new routes `GET /form-schema`, `POST /jira-form-data`,
  `POST /refine-prompt`, `POST /create` (streams via `createWorkspace({ onData })`),
  wired to `sandbox-driver`.
- `manifest.json` / plugin `package.json` — `sandbox-driver` dependency.

**Driver (`packages/sandbox-driver/`):**
- `sandbox.ts` — additive optional `onData` streaming callback on `runSandbox` +
  `createWorkspace` (buffered path unchanged when absent).
- `sandbox.test.*` (or existing suite) — `onData` forwards chunks; return shape
  unchanged.

**Docs:**
- `apps/claudeck/VENDORED.md` — record the core-modal edit and the driver dep.

## Out of scope (YAGNI)

- Editing/duplicating driver logic; the driver is the source of truth.
- Workspace deletion/teardown from this modal (separate concern).
- Any non-workspace project-creation wizardry — Open Folder stays as-is.
