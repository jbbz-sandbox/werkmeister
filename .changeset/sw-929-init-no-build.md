---
"werkmeister": patch
---

SW-929: `werkmeister workspace init` skips the image build, with an info line, when the workspace has no service outside the on-demand profile, instead of ending with `no service selected` and a "images may be incomplete" warning. A workspace with a local service still builds, and a real build failure still warns. On-demand services keep building when they first start (the PR gate starts only the ones a change reaches).
