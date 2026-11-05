---
"werkmeister": patch
---

SW-436: `issue start`'s stale-CLI fix now reads `git -C <checkout> pull --ff-only origin main`, which works under `pull.rebase=true`. When the origin fetch fails, the `CLI:` line says it could not check, names the fetch error and how to re-check, instead of `currency not checked`.
