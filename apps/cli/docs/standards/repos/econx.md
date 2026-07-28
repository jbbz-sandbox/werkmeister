---
repo: econx
summary: Pagination/cursor semantics, federation (@key) rationale, Typesense quirks.
---

# econx — repo notes

Watch for **pagination/cursor semantics**, **federation (`@key`) rationale**, and
external-system quirks (Typesense).

```ts
// Typesense builds `filter_by` from user input; reject whitespace / && / || so a
// value can never inject an extra clause. Keep in sync with web-v2 sanitizeFilterValue.
const safe = sanitizeFilterValue(input);
```
