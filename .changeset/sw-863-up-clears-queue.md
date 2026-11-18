---
"werkmeister-core": patch
---

`feature up` leaves the waiting queue and clears `waiting.json` once its containers start. An admit that returned early (Docker unreadable, or a zero-cost start) left both, so the hook kept saying "queued" over a running feature (SW-863).
