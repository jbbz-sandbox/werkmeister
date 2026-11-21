---
"werkmeister-core": minor
---

`pr open` and `pr status` write `pr.open`, `pr.merged` and `release` to the metrics log (`~/.werkmeister/metrics/events-YYYY-MM.jsonl`), timed by GitHub's `createdAt` / `mergedAt` and the release tag's date, not the local clock (SW-779). A PR whose time can't be read gets no event and a warning.
