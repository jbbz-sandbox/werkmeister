---
"werkmeister-core": patch
"werkmeister": patch
---

SW-335: `werkmeister machine detect` names the shared install's `node_modules_volume` `<repo>-node-modules` instead of `node-modules`, so two repos in one workspace no longer share one install volume (an existing fragment's name is kept on a re-run). With a lockfile, the install command is npm's clean install or `pnpm install --frozen-lockfile`, so an up can't rewrite it. New docs page: docs/repo-setup.md, on setting up a repo for Werkmeister.
