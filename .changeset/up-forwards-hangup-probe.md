---
"sandbox-core": patch
---

`sandbox up` no longer exits mid-run with Node's "unsettled top-level await" warning while waiting for restarted k8s port-forwards. The redis/postgres probe now treats a peer that hangs up without replying (Docker's port proxy before the tunnel binds) as down instead of waiting forever, so the wait either sees the forwards return and goes on to start the containers, or fails with `FORWARDS_NEVER_READY` (#207). `sandbox status --k8s` and the dashboard's forwards check share the probe and can no longer hang the same way.
