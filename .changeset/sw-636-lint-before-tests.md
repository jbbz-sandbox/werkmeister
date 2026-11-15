---
"werkmeister": patch
"werkmeister-core": patch
---

SW-636: the test commands `werkmeister-context.md` prints, and the allow rules that match them, now run the repo's `lint:` before the test command (`<lint> && <test>`), not after it. A format error now fails within seconds instead of after the full test run: in the werkmeister repo, about 7 s rather than turbo's ~6 minutes. A repo with no `lint:` gets the same lines as before.
