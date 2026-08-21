# Vendored from upstream

This directory is a snapshot copy of the upstream **claudeck** project,
vendored under its MIT license (see `LICENSE`).

- **Source:** https://github.com/hamedafarag/claudeck
- **Commit:** bb0fd54db457ccf10de97c8407102e54e4b4280a
- **Upstream version at snapshot:** 1.4.2
- **Vendored:** 2026-07-24
- **Method:** `npx degit hamedafarag/claudeck#<commit> apps/claudeck`

Note the version distinction: the snapshot was taken from upstream 1.4.2, but
`package.json` now carries this fork's own version, which is independent of
upstream's numbering.

## Local modifications
- Added this `VENDORED.md`.
- Re-attributed `package.json` to this fork: `author` is Jay Boyer, `version`
  restarted at 1.0.0, and `homepage`/`repository` point at this monorepo rather
  than upstream. `LICENSE` keeps Hamed Farag's copyright — MIT requires the
  notice be retained in copies — with a second line covering the modifications
  here. `README.md`, `CHANGELOG.md` and `docs/index.html` were re-attributed
  too: author bylines, `<meta name="author">`, schema.org author fields, the
  star-count API call and every link to *this* project now point at
  `jbbz-sandbox/sandbox`. `CHANGELOG.md` gained a note marking entries
  through 1.4.2 as inherited upstream history. Added `private: true` to
  `package.json` so this fork cannot be published under upstream's npm name.
- Still pointing at upstream, because they are third-party service addresses
  rather than authorship credits, and repointing them would break the features
  that use them: the `claudeck-marketplace` registry (now overridable via
  `CLAUDECK_MARKETPLACE_REPO`) and the `claudeck-skills` install URLs in
  `README.md` and `docs/index.html`.
- **Not changed:** `CNAME` and `docs/CNAME` still contain `claudeck.app`,
  upstream's domain. Harmless while GitHub Pages is not configured for this
  directory, but delete them before enabling Pages.
- Added built-in plugin `plugins/sandbox-workspace/` (Phase 3): a project-scoped
  "Workspace" tab showing the selected sandbox feature workspace's repo worktrees
  and git state. Self-contained (no dependency on our other packages); does not
  modify any vendored core files. Phase 3 additions: per-worktree PR status
  (`gh`, in the main `GET /` response), docker service status
  (`GET /docker` → `docker compose ps`), and lifecycle actions
  (`POST /action` → `sandbox up|stop|restart|down`, output streamed as chunked
  text/plain from the plugin's own route — no core WebSocket dependency). The
  tab badge shows the open-PR count. Still self-contained; no core edits.
- **Create Workspace** (project-layer feature): the core Add Project modal
  (`public/js/components/add-project-modal.js`) is now a two-tab modal
  (Open Folder | Create Workspace), with tab-switch + post-create glue in
  `public/js/features/projects.js`. The Create tab lazy-imports the
  sandbox-workspace plugin's `create-form.mjs`; the plugin gained a
  `sandbox-core` dependency and routes (`form-schema`, `jira-form-data`,
  `refine-prompt`, `create`). `sandbox-core` must be built (`tsc`) before
  claudeck runs.
- **Workspace → project-list sync**: the sandbox-workspace plugin mirrors the
  workspaces root into `~/.claudeck/config/folders.json` (the list core's
  `/api/projects` serves) at mount and on every `fs.watch` event for that
  directory — `merge-folders.mjs` in the plugin dir. Entries it owns carry
  `source: "sandbox"`; manual entries elsewhere are left alone. Writes core's
  config file but still edits no core code.

To update: re-run degit at a newer commit into a scratch dir and diff, or
merge from a `claudeck-upstream` remote if configured.

## Phase 1 acceptance (2026-07-24)

- **Launch:** `node cli.js --port 9009 --no-auth` — server up at http://localhost:9009,
  `better-sqlite3` native module loads, `/api/version` → 200, UI served.
- **Chat rooted at workspace:** registered `<workspaces_root>/claudeck-test`
  as a project; chat confirmed rooted there (`pwd` returned the workspace dir).
- **Billing:** subscription, not API. No `ANTHROPIC_API_KEY` in the shell or
  `~/.claudeck/.env` (injects only `PORT` + VAPID keys), so the SDK uses the
  `claude login` (Max) subscription. The per-session `$` figure claudeck shows is
  Claude Code's standard cost estimate, not an API charge.

Phase 1 complete. Next: Phase 2 (feature workspaces auto-registered as claudeck
projects) and Phase 3 (sandbox management as a claudeck plugin).
