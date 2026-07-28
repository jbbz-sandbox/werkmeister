---
domain: comments
applies_to:
  - "**/*"
phase: [implement, review]
summary: Universal comment rubric — comments explain the why, never the what.
---

# Code comments

Comments explain the **why**, never the **what**. The code itself carries the *what* —
through good names, clear types, and small functions. A comment earns its place only when
it tells the reader something the code cannot.

## Rubric

1. **Delete comments that restate the code.** If the comment and the line say the same
   thing, the comment is pure noise — and the first thing to rot when the code changes.
2. **Keep and sharpen comments that explain genuine ambiguity.** The *why* behind a
   decision, non-obvious constraints, units, invariants, ordering/scheduling requirements,
   external-system quirks, cross-service contracts, edge cases, and ticket references
   (e.g. `TRE-1234`). If a competent reader couldn't infer it from the code, it belongs in
   a comment. See the per-repo notes under [repos/](repos/) for the quirks that matter most
   in each codebase.
3. **Tighten survivors to one concise, useful line.** No banner art, no restating types,
   no narrating history that git already records. Keep docstrings that add value; drop
   docstrings that only echo the signature.
4. **Prefer self-documenting code over a comment.** A well-named variable, an extracted
   constant, or a small named function usually removes the need for the comment. Reach for
   prose only when a name genuinely can't carry the meaning.

## The test

Before writing a comment, ask: *"Could a competent reader work this out from the code
alone?"* If yes, improve the code instead of adding the comment. If no, write the shortest
comment that closes the gap.

## Examples

```ts
// Bad — restates the code; first thing to drift when the line changes
// set the collection name
const collection = COLLECTION_NAME;

// Good — explains a non-obvious *why* the code can't show
// Typesense builds `filter_by` from user input; reject whitespace / && / || so a
// value can never inject an extra clause. Keep in sync with web-v2 sanitizeFilterValue.
const safe = sanitizeFilterValue(input);

// Best — a precise name removes the need for any comment
const isColdConnect = elapsedMs > COLD_CONNECT_THRESHOLD_MS;
```
