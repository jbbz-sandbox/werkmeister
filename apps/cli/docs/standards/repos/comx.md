---
repo: comx
summary: External-system quirks (Typesense) and injection-safe filter construction.
---

# comx — repo notes

Watch for **external-system quirks** (Typesense) and injection-safe filter construction.

```ts
// Typesense builds `filter_by` from user input; reject whitespace / && / || so a
// value can never inject an extra clause. Keep in sync with web-v2 sanitizeFilterValue.
const safe = sanitizeFilterValue(input);
```
