---
"werkmeister": patch
---

`werkmeister connect` works with Docker Compose v5. Compose now builds through `buildx bake`, which refused the k8s-forwards image's `corp-ca.crt` secret because it sat outside the directory compose ran from. Shared-infra compose commands now run from the config directory that holds the secret (`~/.werkmeister`, or `~/.sandbox` on older setups). When shared infra fails to start, `connect` now says so and exits 1, instead of printing "All 1 services healthy" for the containers that happened to exist.
