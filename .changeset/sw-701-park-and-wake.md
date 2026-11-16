---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-701): a `feature up --service` start that waits its 10 minutes without room now keeps its queue place instead of leaving it. It still exits 75, but it stays queued with its first wait time; when room frees, the grant pass starts that service, reloads the proxy and tells the session to continue. A rerun keeps its place. A parked start never holds the room against later starts, so a start that can't fit can't stall the queue. Gate starts, and starts that stopped their own containers to wait, don't park.
