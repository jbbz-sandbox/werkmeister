---
"werkmeister": patch
---

SW-952: `werkmeister pr status` counts every public member of a changesets `fixed` group in `release_packages` when a PR's changeset names one of them, so a release where only `werkmeister-core` failed to publish reads `partially released`, not shipped.
