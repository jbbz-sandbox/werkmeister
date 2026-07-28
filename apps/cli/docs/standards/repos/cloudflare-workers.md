---
repo: cloudflare-workers
summary: Ordering requirements — routing matchers are first-match-wins.
---

# cloudflare-workers — repo notes

Watch for **ordering requirements** — routing matchers are first-match-wins.

```ts
// Routing matchers are first-match-wins; keep the catch-all last or specific
// paths get swallowed. (mirrors route-config.js ordering)
const route = matchRoute(request.url);
```
