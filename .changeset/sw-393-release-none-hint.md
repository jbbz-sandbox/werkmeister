---
"werkmeister": patch
---

`werkmeister workspace close`, refusing a workspace with a merged PR, now says that a PR which ships no release needs `release: none` in its PR file. The PR rules and docs say a change that ships nothing sets `release: none` beside `skip_release`; `skip_release` alone still waits for a release tag in a `ship: tag` repo (SW-393).
