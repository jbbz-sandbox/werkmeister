---
"werkmeister-core": patch
---

Under `with-temp-home` (`WERKMEISTER_TEMP_HOME` equal to `HOME`) or a fixture run, werkmeister now leaves the login session's shared state alone. `daemon install`/`uninstall`, `pr watch --install`/`--uninstall` and `machine setup`'s daemon and pr-watch steps skip before any `launchctl` or `crontab` call. `machine migrate` skips its pr-watch step. Caddy reload and start and the host web servers (with launchd's `kickstart`) skip through `sharedProxySkipReason()`. `infra up`/`down`/`stop`/`restart` skip their shared-container half, and the k8s-forwards repair (`infra connect --k8s`, `feature up`) never recreates the shared container. launchd, the crontab and the docker daemon are keyed on uid and `DOCKER_CONFIG`, not HOME, so a temp HOME used to reach the real daemon and Caddy (SW-1054).
