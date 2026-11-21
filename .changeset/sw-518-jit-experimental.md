---
"werkmeister-core": patch
"werkmeister": patch
---

JIT is marked experimental and ICM the supported strategy (SW-518): in the `--context-strategy` help of `workspace new` / `workspace init`, in the create form (the Workflow select shows "jit (experimental)" through `ui:enumNames`; the stored value is still `jit`), and on each docs page that names JIT. `docs/context-strategies.md` adds the triage rule: a JIT-only bug is filed but not scheduled unless it also breaks ICM. ICM was already the default for new workspaces.
