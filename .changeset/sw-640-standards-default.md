---
"werkmeister-core": patch
---

Once `machine setup` has run on a fresh install, `machine setup --check` no longer fails with "no standards tree". When `overrides.standards_dir` is unset, the standards tree now defaults to `~/.werkmeister/standards`, which `machine setup` creates with a README describing the module layout and never overwrites; before that first run, `--check` names the folder it would create. The old default pointed inside the package, at a folder it never shipped. The "Claude Code standards access" step now offers that folder on the first run too, instead of skipping. A configured `overrides.standards_dir` is unchanged, and setup never creates it (SW-640).
