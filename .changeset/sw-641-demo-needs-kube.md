---
"werkmeister": patch
---

`werkmeister machine setup` offers the demo apps only when a kube context is set, and says why it skipped them otherwise: their backend reaches Postgres and Redis through the cluster, so without one `feature up` could not start them. Quick Start says the same (SW-641).
