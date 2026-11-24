---
"werkmeister-vscode": patch
---

SW-1133: Hide Waiting on Release now hides a merged card whose only need is a registry-sync notice ("Registry sync needed"). That is a machine-wide step shown elsewhere, not something waiting in that workspace. A card with a question, a gate, a held PR update for its session or any other need still shows.
