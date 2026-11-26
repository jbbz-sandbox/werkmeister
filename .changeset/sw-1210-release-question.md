---
"werkmeister-core": patch
---

SW-1210: step 0 of the generated ICM first stage (every work type) now says that when the repo's `Release check:` is `changeset status`, a question on whether the change needs a release entry offers two answers: an empty changeset (`changeset add --empty`, no release) or a patch or minor entry, never none. The release check fails on a changed package with no changeset.
