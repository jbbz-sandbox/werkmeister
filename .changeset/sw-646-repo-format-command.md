---
"werkmeister": minor
"werkmeister-core": minor
---

A repo can declare `format:` in its `.werkmeister/services.yaml` `repo:` block, e.g. `pnpm exec biome check --write {files}`, `uv run ruff format {files}` or `./gradlew spotlessApply`. `werkmeister-context.md` lists it under "Repo commands", with `release_check` for a `ship: tag` repo. The ICM contracts and the generated `w9r-pr` skill no longer name biome, pnpm or changesets as a managed repo's commands. A repo with no `format:` gets no format step; the gate's `lint` still checks formatting.
