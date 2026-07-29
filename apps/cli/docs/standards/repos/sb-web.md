---
repo: sb-web
summary: Render/effect ordering and hydration or caching caveats.
---

# sb-web — repo notes

Watch for **render/effect ordering** and **hydration or caching caveats**. The *what* is
carried through good names, clear types, and small functions/components.

```ts
// Bump this key when the payload shape changes, or stale CDN-cached responses
// poison hydration for users on the old version. (PROJ-1234)
const cacheKey = `reviews:v3:${slug}`;
```
