---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-737): a queued feature is started when room frees, even with no stop to trigger it. One waiter whose start failed (low memory or host load, a missing compose file) ended the whole grant pass, so every 10-minute `pr watch` tick failed on it and nothing behind it started, on an idle host too. The pass now skips that waiter and keeps it queued. A `--service` or gate start now runs a grant after it starts, and a start that gives up waiting runs one for those still queued.
