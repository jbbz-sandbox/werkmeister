---
repo: sandbox
summary: Generated-projection boundaries and config-compiler quirks (Caddy, compose, skills).
---

# sandbox — repo notes

Watch for **generated-projection boundaries** and **config-compiler quirks**. Most files
under `infra/proxy/`, `infra/compose/`, and a workspace's `.claude/` are *compiled
projections* — regenerated on `sandbox up` / `connect` / `init-workspace`. A hand-edit
there is silently overwritten, so the comment that earns its place is the one explaining
why a generator emits something surprising.

```ts
// Caddy groups sibling `handle` blocks into a mutual-exclusion set: only the
// first match runs and the rest vanish from the compiled config (blank pages,
// content-length: 0). Emit `route { ... }` so matchers stay ordered and none
// are dropped. See docs/known-issues.md.
lines.push("    route {");
```

Also worth a comment here: **fail-open doctrine** in anything that runs as a hook (a
broken hook must never tax or block every edit), and **marker-based merges** into
user-owned files like `.claude/settings.json`, where the generator owns only the entries
carrying its marker and must preserve everything else.
