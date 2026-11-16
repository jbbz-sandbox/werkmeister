---
"werkmeister-core": patch
---

SW-761: two SDK contract fixes. `getFormSchema()`'s `schema` is now typed as the form's JSON Schema (`properties`, `required`), so `validateFormData(await getFormSchema(), data)` type-checks without a cast; every old read still compiles. A provisioning failure from `createWorkspace({ live: true })` is now a `WorkspaceError` (its class stays `WorkspaceInitError`, its `code` becomes `WORKSPACE`), so catching `WorkspaceError` catches it.
