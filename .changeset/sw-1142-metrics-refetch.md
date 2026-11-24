---
"werkmeister": patch
---

SW-1142: the dashboard Metrics tab calls `metrics-trends` each time it is opened, like Flow and Health, so a workspace that closed while the dashboard was open shows without a range click. It makes no call while hidden.
