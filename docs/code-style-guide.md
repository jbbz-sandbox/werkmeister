# Sandbox — Code Style Guide

> **Canonical, cross-repo standard — a thin index.** The rubric and per-repo notes that used
> to live in this file are decomposed into one module per concern under
> [apps/cli/docs/standards/](../apps/cli/docs/standards/), each carrying frontmatter
> (`domain:`, `summary:`, `applies_to:`, `phase:`) consumed by the JIT context system —
> see [jit-context-system.md](jit-context-system.md). Edit the modules; this index just routes.
>
> Living documents. When a code review keeps surfacing the same nit, encode it in the matching
> module so it only has to be said once. Start small; extend as patterns emerge — the
> graduation pipeline (`decision` note → `sandbox notes graduate` → `sb-author`) is the
> sanctioned path.

## Modules

Each domain is `apps/cli/docs/standards/<domain>/STANDARD.md` (+ optional `references/*.md`).
The domain table — what each one covers — lives in
[jit-context-system.md §3](jit-context-system.md#3-content-model--the-standards-tree); it is
not duplicated here.

`comments` and `engineering` are the universal base: always active, ungated by file type. The
rest (`service`, `config`, `auth`, `testing`, `observability`, `data`, `ui`) load only when a
changed file matches their `applies_to` globs.

## Per-repo notes

The rubric is identical everywhere; what differs per repo is *which* quirks most often justify
a comment. One snippet per repo under
[apps/cli/docs/standards/repos/](../apps/cli/docs/standards/repos/). These are referenced from
standard bodies — they are not loadable standards in their own right.

## How standards reach a workspace

Which modules apply to a given ephemeral workspace is computed from the archetype of each
service in `~/.sandbox/services.yaml` (plus `.sandbox/workspace.yml` `standards_override`) and
rendered as a **"Standards routing"** block in the workspace's generated `CLAUDE.md`. The
universal base is always active.

Full mechanism — resolution, generated skills, entry skills, agents, hooks, the standards
gate: [jit-context-system.md](jit-context-system.md).
