---
"werkmeister": minor
"werkmeister-core": minor
---

SW-1099: the dashboard Metrics tab charts stage and ticket time. It shows p50/p90 minutes per ICM stage per bucket (one line per stage), a stage heatmap, the bottleneck stage with its share of stage time ("03_implement: 54% of stage time"), each stage's time split into waiting on a person, waiting on capacity and working, and lead time from the first turn to merge and to release, with the five slowest tickets linking to their Flow timeline (`#flow/<workspace>`). Every chart follows the version filter. `metrics-trends` stages gain `totalMinutes`, `personMinutes`, `capacityMinutes` and `workingMinutes`, and each row and version slice a `slowest` list. Flow's scatter now shows cycle time only; lead time moved to Metrics.
