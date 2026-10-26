---
"werkmeister-core": minor
"werkmeister": minor
---

SW-102: a machine with no Kubernetes cluster can now get a baseline.

- **A new `baseline_upstream` key.** Set `baseline_upstream: "host:port"` on a service in `services.yaml`. Its `{service}` references and its generated `<SVC>_URL` / `_HOST` / `_PORT` then resolve to that address instead of `k8s-forwards`. Before, they threw an error (or the env vars were left out) when the service had no `k8s_forward_port`. The key wins over `k8s_forward_port`, and a service that declares it gets no forward. `status` reports it as `baseline`, and the fragment schema accepts the key.
- **Baseline containers in `w9r-infra`.** Add `infra.baseline.<service>.image` to `~/.werkmeister/config.yaml`, pinned as `<image>@sha256:<digest>`; a tag-only image is refused. Optionally add `environment`. `connect` then runs the image in `w9r-infra` as `w9r-baseline-<service>`, reachable at `baseline-<service>` on the shared network. Point the service's `baseline_upstream` at that alias.
- **Removing a baseline.** Its container keeps running until `down infra`.

See *Without Kubernetes* in `docs/topology.md`.
