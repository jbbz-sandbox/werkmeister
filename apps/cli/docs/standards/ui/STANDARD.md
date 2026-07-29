---
domain: ui
applies_to:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/components/**"
  - "**/hooks/**"
phase: [implement, review]
task_signatures:
  - "hydration"
  - "useeffect"
  - "jsx"
  - "tsx"
  - "frontend"
  - "nextjs"
  - "next.js"
summary: UI standard — render/effect ordering, hydration and CDN caching caveats.
---

# UI standard

The shared comment rubric ([comments.md](comments.md)) applies in full. Below are only the
frontend-specific cases where a comment is earned, plus this codebase's idioms.

## What justifies a comment

- **Render/effect ordering** — why an effect runs where it does, dependencies that are
  deliberately omitted or included, and ordering constraints between effects.
- **Hydration caveats** — anything that behaves differently between server render and
  client hydration, or that would mismatch if moved.
- **CDN cache-key versioning** — payload-shape changes that must bump a cache key, or
  stale cached responses poison hydration for users on the old version.

The *what* is carried through good names, clear types, and small functions/components.

## Idioms

```ts
// Bump this key when the payload shape changes, or stale CDN-cached responses
// poison hydration for users on the old version. (PROJ-1234)
const cacheKey = `reviews:v3:${slug}`;
```

## Before you write

Could a competent reader infer this from the component + types alone? If yes, fix the
name/structure. If no, write the shortest comment that closes the gap.
