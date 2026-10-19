# Werkmeister — Code Style Guide

> **Canonical, cross-repo standard — a thin index.** The rubric and per-repo notes that used
> to live in this file are decomposed into one module per concern under
> [jbbz-sandbox/sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards), each carrying frontmatter
> (`domain:`, `summary:`, `applies_to:`, `phase:`) consumed by the JIT context system —
> see [jit-context-system.md](jit-context-system.md). Edit the modules; this index just routes.
>
> Living documents. When a code review keeps surfacing the same nit, encode it in the matching
> module so it only has to be said once. Start small; extend as patterns emerge — the
> graduation pipeline (`decision` note → `werkmeister notes graduate` → `sb-author`) is the
> sanctioned path.

## Modules

Each domain is `<domain>/STANDARD.md` (+ optional `references/*.md`) in
[sandbox-standards](https://github.com/jbbz-sandbox/sandbox-standards), which the CLI resolves via `overrides.standards_dir`.
The domain table — what each one covers — lives in
[jit-context-system.md §3](jit-context-system.md#3-content-model--the-standards-tree); it is
not duplicated here.

`comments` and `engineering` are the universal base: always active, ungated by file type. The
rest (`service`, `config`, `auth`, `testing`, `observability`, `data`, `ui`) load only when a
changed file matches their `applies_to` globs.

## Per-repo notes

The rubric is identical everywhere; what differs per repo is *which* quirks most often justify
a comment. One snippet per repo under
[repos/](https://github.com/jbbz-sandbox/sandbox-standards/tree/HEAD/repos) in that repo. These are referenced from
standard bodies — they are not loadable standards in their own right.

## How standards reach a workspace

Which modules apply to a given ephemeral workspace is computed from the archetype of each
service in `~/.werkmeister/services.yaml` (plus `.werkmeister/workspace.yml` `standards_override`) and
rendered as a **"Standards routing"** block in the workspace's generated `CLAUDE.md`. The
universal base is always active.

Full mechanism — resolution, generated skills, entry skills, agents, hooks, the standards
gate: [jit-context-system.md](jit-context-system.md).
