---
"werkmeister": minor
---

The dashboard's Flow tab draws its charts (SW-783), below the board and following its range buttons: wait time by cause as weekly stacked bars (on you, capacity, PR/CI, gate retry, release), cycle time per ticket as a scatter by merge date with p50 and p90 lines and a Lead toggle, tiles for estimated cost, tokens with cache-read share, active versus wall time and turns over the range's closed runs, and agent time per day. All inline SVG, no chart dependency. The `metrics` report gains `agentByDay`: active minutes per UTC day, each session counted on its first turn's day (a closed run whose `usage.json` has no session list, on its close day).
