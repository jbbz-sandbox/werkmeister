---
repo: logging-service
summary: Back-pressure and drop semantics on the request path.
---

# logging-service — repo notes

Watch for **back-pressure and drop semantics** on the request path.

```ts
// Drop on the floor past this threshold: back-pressure here would stall the
// request path, and lost log lines are cheaper than blocked traffic.
if (queue.length > MAX_BUFFERED) return;
```
