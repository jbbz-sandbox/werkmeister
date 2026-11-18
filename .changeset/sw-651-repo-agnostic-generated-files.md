---
"werkmeister": patch
"werkmeister-core": patch
---

Generated `.werkmeister/pr-rules.md` no longer names Changesets outside the two places that explain changesets-only behaviour: the release-bot example, the merged-PR release note and the quoted `skip_release` example now say "release entry". The repo-agnostic test now checks every markdown file `workspace init` writes (skills, `_shared/`, `CLAUDE.md`), not only the stage contracts.
