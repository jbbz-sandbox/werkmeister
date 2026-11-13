# Changesets

A changeset is one file per user-visible change, written in the PR that makes it.
`npx changeset` writes one interactively.

A change that ships nothing to a package (tests, CI, docs) still needs `pnpm changeset add --empty`: the gate's release check fails on any changed package without a changeset.

**Which package to name.** `werkmeister` and `werkmeister-core` both publish
(SW-658), and `fixed` in `config.json` keeps them on one version, so naming either
releases both. The changeset's text lands only in the changelog of each package it
names; one not named gets a bare version heading. Name `werkmeister-core` for a
change to its public SDK (`werkmeister-core/sdk`), the CLI for what CLI users see,
and both when it is both. Changes to core's internal entry points name the CLI:
the CLI bundles core, so they ship as a CLI release.

`changeset status` only sees tracked files: `git add .changeset/<file>.md`
before running it, or it fails with "Some packages have been changed but no
changesets were found" even though the changeset exists.

`werkmeister-vscode` is in the `fixed` group but private: it versions, never
publishes. The workspaces in `ignore` (dashboard, docs site, plugin) never
publish and carry no changelog. A changeset naming one of them is an error, deliberately.
