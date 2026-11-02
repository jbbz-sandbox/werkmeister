## Description

Checks the configured standards tree for structural errors and exits 1 on any, so a malformed standards edit fails loudly instead of silently dropping out. It also checks each repo's own tree (`<repo>/.werkmeister/standards/`, for every main checkout under `paths.repos_root`) and fails when a repo module reuses a global module's `domain`. It prints the tree's path. Unlike `werkmeister skills check`, it is not tied to a workspace.

## Examples

```bash
werkmeister standards check
```
