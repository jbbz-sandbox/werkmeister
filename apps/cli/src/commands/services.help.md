## Description

Shows each service of a running feature with its source and endpoint:

```
=== Services for: my-feature ===

  Service                    Source    Endpoint                        Type           
  ──────────────────────────────────────────────────────────────────────────────────
  backend                    k8s      localhost:9052                  api
  frontend                   local    localhost:11101                 web
  search                     baseline  localhost:11102                 api

  local = running in Docker on this machine  |  baseline = services.yaml baseline_upstream  |  k8s = port-forwarded from k8s cluster
```

`Source` is `local` for a container running on this machine, `baseline` for the `baseline_upstream` named in `services.yaml`, `k8s` for a port-forward from the cluster, and `N/A` when the service has no endpoint (`(not configured)`). If the feature isn't running, the command says so and prints `werkmeister feature up <feature>` instead of failing.
