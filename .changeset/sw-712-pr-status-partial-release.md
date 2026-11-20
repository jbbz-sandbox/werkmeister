---
"werkmeister": patch
---

`werkmeister pr status` in a changesets repo records, at merge, the public packages the PR's own changesets name (`release_packages:`). It marks the PR shipped only once each of those packages has a `<pkg>@*` release tag. Until then it reports `partially released: <pkg> missing`, and neither moves the issue to Done nor prompts a close-out (SW-712).
