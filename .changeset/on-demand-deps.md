---
"werkmeister": patch
---

A service's `depends_on` on another checked-out service now starts that dependency (SW-942). A workspace service's dependency is rendered as a workspace container, with its env file and secrets, so `werkmeister feature up` starts it, and so does the PR gate's service start. Before, it sat behind the `on-demand` profile, and the service's test failed with `could not translate host name` until `feature up --service <dep>`. An on-demand service now keeps its on-demand dependencies, so `feature up --service <svc>` starts them too. A dependency outside the workspace's checked-out repos (k8s or baseline) is unchanged.
