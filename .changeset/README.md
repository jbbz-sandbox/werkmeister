# Changesets

A changeset is one file per user-visible change, written in the PR that makes it.
`npx changeset` writes one interactively.

**Name the CLI, not `sandbox-core`.** `@jbbz-sandbox/sandbox-cli` is the only
package that publishes, and the changeset's text lands in the changelog of
whichever package it names — a changeset naming `sandbox-core` still releases,
but its description ends up in a private package's changelog while the published
one gets a bare version heading.

`sandbox-core` is `fixed` to the CLI in `config.json`, so its version tracks
automatically. That mirrors the build: esbuild bundles core *into* the CLI, so
the two are one shipped artifact and a core change is a CLI release.

The other three workspaces are `ignore`d — they never publish and carry no
changelog. A changeset naming one of them is an error, deliberately.
