---
"werkmeister": patch
---

`werkmeister pr open`'s YAML-error hint for a PR file now quotes `skip_release: "no release entry: docs only"`, the wording the generated pr-rules use, instead of naming changesets, which a repo without them doesn't have (SW-877).
