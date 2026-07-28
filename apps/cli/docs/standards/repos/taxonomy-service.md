---
repo: taxonomy-service
summary: Resolution-order invariants (shallower nodes shadowing deeper ones).
---

# taxonomy-service — repo notes

Watch for **resolution-order invariants** (shallower nodes shadowing deeper ones).

```ts
// Walk parents breadth-first: the first match wins, so a shallower category
// node must shadow a deeper synonym of the same slug.
const category = resolveCategory(slug);
```
