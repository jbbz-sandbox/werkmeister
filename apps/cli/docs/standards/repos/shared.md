---
repo: shared
summary: Cross-service contracts — contract stability deserves a comment.
---

# shared — repo notes

Watch for **cross-service contracts** — consumers across many services read this code
without its original context, so contract stability deserves a comment.

```ts
// Consumers depend on this shape staying backward-compatible; add fields, never
// rename or remove without a coordinated migration. (TRE-1234)
export interface ReviewSummary { /* ... */ }
```
