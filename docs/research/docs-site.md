# Public docs site and docs-sync: research and recommendation

[SW-78](https://jory-group.atlassian.net/browse/SW-78), October 2026. This is a research spike: it recommends and files tickets. Nothing here is built yet. Related: [SW-26](https://jory-group.atlassian.net/browse/SW-26) (Product Hunt launch, landing page), [SW-4](https://jory-group.atlassian.net/browse/SW-4) (werkmeister.io).

## Decision

| Question | Decision |
|---|---|
| Generator | **VitePress 1.6.x**, plain `.md`, no MDX |
| Hosting | **GitHub Pages** from this repo (it is public), deployed by the release job |
| Domain | **`werkmeister.io`** apex: one site, with a `layout: home` landing page at `/` and the docs under it. It waits on SW-4 registering the domain (whois said "Domain not found" on 2026-10-23). Until then it is served at the github.io URL |
| Public docs | `README.md`, `docs/users-guide.md`, `topology`, `sandbox-architecture`, `workspace-lifecycle`, `troubleshooting-advanced`, `known-issues`, `third-party`, `docker-resource-optimization`, `plugins/werkmeister/README.md`. Optional: the VS Code extension and MCP READMEs |
| Internal | `docs/research/`, `docs/superpowers/`, `docs/design/`, the naming, context-management and SCAMPER research, `jit-context-*`, `notes-conventions`, `code-style-guide`, `docs-sync`, `ponytail-debt`, `ui-spec`, `docker-socket-replacement`, `CONVENTIONS.md`, `MANUAL-CHECKLIST.md`, every `SKILL.md` |
| Sync, in order | 1. extend `docs:check` · 2. build the site · 3. `docs:gen` generated regions · 4. TypeDoc `{@link}` validation · skill snippet smoke runs: not now |

Still to settle in the site ticket: `docs/jira-rest-setup.md` (linked from the users-guide, but names our Atlassian site) and `docs/context-strategies.md` (linked from workspace-lifecycle, mostly exploration).

## Generator

Prototype builds of a copy of the 11 candidate docs, 2026-10-23:

| | VitePress 1.6.4 | Docusaurus 3.10.2, `format: 'detect'` | Docusaurus 3.10.2, MDX | Starlight 0.42.7 |
|---|---|---|---|---|
| Edits to build | 5 escaped placeholders | 0 | 5+ (MDX parse errors) | frontmatter `title` in 11 of 11 files |
| Relative doc links | resolve | resolve | — | 28 rejected by the links validator's default |
| Broken doc link fails the build | yes, by default | yes | yes | yes |
| Build / `node_modules` | about 10 s / 101 MB | about 27 s / 328 MB | — | 215 MB, Node `>=22.23.4` |

All of them fail on the 15 links from public docs to repo files (`LICENSE`, `apps/cli`, a probe script). A 15-line link hook that sends any non-doc target to its GitHub URL fixes that without touching the docs. The 5 placeholders (bare `<url>`, `<tag>`, `<repo>` in prose) are a bug today: GitHub's renderer drops them silently (checked with `gh api markdown`). VitePress refusing to build is what surfaced them.

Ruled out on paper: MkDocs Material (maintenance mode until 2027-05-05, Python), Fumadocs (a Next.js app for about 12 pages), Nextra (releases slowing), Mintlify (hosted, needs a read/write GitHub App, no static export found). VitePress's own risk is a quiet stable line: 1.6.4 shipped 2025-08-05 and v2 is in alpha. The docs stay plain Markdown, so moving to Docusaurus `detect` later is a config change.

Search: VitePress's built-in local search. Versioning: none. There have been 22 releases since 2026-10-18, so the site deploys on release and tracks the latest one. Nav: a hand-kept sidebar of about 12 entries.

## Hosting

GitHub Pages is free for a public repo and needs no new account or token. Netlify's free plan allows about 20 production deploys a month before it pauses every project, which is too few at our release rate. Cloudflare needs the zone on its nameservers for an apex domain, and its advantage (PR previews) isn't needed when CI already fails on broken links. Sources: GitHub Pages limits and custom-domain docs, Netlify and Cloudflare pricing and limits pages, accessed 2026-10-23.

## Docs-sync

Measured against `scripts/check-docs.mjs` on 2026-10-23:

- **`docs:check` gaps.** It reads only flags that come straight after the command word: 19 of 55 documented flag uses are unchecked. Only 3 of those are subcommand flags (`pr watch --install`); 12 follow a positional argument (`down my-feature --volumes`). It skips `sandbox <cmd>` lines (122 in the skills), bare `<placeholder>`s and `#anchor` links. One anchor in the users-guide (`#k8s-port-forward-scripts`) points at no heading. **Adopt first:** it's one script, its findings are known, and it clears what the site build would choke on.
- **Generated regions.** The autonomous allow/deny paragraph in `docs/context-strategies.md` carries a `docs-check: ignore`, so the most drift-prone list is not checked at all. Order: allow/deny lists, then the MCP tool list (48 registrations), the users-guide CLI reference, and the README workspaces table. Generated regions are plain Markdown, so the site needs nothing extra for them.
- **TypeDoc.** `typedoc --emit none` with `invalidLink` as an error ran over `werkmeister-core` in 3.7 s. It found 1 broken `{@link}` out of 98 (`resolveSandboxBin` in `claude_cli.ts`). Validation only: `werkmeister-core` is private, so an API reference has no readers.
- **Skill snippets.** 42 shell blocks in 16 skills. Nearly all need live containers, Caddy or k8s, so in CI they could only be parsed. Checking `sandbox <cmd>` lines in `docs:check` covers the cheap part. Not now; revisit if skills keep breaking.
- **Site build and `docs:check`.** The deploy job `needs:` the existing `docs:check` CI step and keeps VitePress's dead-link failure on. They overlap only on relative doc links.

## Follow-up tickets

Filed in SW, each related to SW-26 and SW-4:

1. [SW-79](https://jory-group.atlassian.net/browse/SW-79): `docs:check` checks flags anywhere in a command, subcommand flags, `sandbox <cmd>` lines, bare placeholders and anchors
2. [SW-80](https://jory-group.atlassian.net/browse/SW-80): Public docs site, VitePress on GitHub Pages at werkmeister.io
3. [SW-81](https://jory-group.atlassian.net/browse/SW-81): `docs:gen` generated regions, verified by `docs:check`
4. [SW-82](https://jory-group.atlassian.net/browse/SW-82): TypeDoc `{@link}` validation for `werkmeister-core` in CI

Next: SW-79, then SW-80.
