---
repo: sandbox
summary: External-system quirks (Mongo, Typesense, change streams).
---

# sandbox — repo notes

Watch for **external-system quirks** (Mongo, Typesense, change streams). The *what* is
carried through good names, clear functions, and small modules.

```js
// Ids still in the set but not returned by the query were hard-deleted between
// enqueue and now — drop them from Typesense too. (TRE-2022)
for (const id of staleIds) await collection.documents(id).delete();
```
