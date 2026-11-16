---
"werkmeister-core": patch
---

SW-770: SDK docs link `SandboxError` and `WorkspaceError` in `@throws` again instead of showing them as plain code. `docs:links` now resolves a `{@link Name}` the SDK exports, so `@throws {@link SandboxError}` passes both `docs:links` and `docs:sdk` in any source file.
