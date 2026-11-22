---
"werkmeister": patch
---

The pane render script finds Playwright's chrome-headless-shell in `PLAYWRIGHT_BROWSERS_PATH` or the real home's Playwright cache, so its `.png` works under a workspace's `with-temp-home` without `CHROME` set (SW-1016).
