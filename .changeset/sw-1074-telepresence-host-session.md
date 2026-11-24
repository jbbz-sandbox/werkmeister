---
"werkmeister-core": patch
"werkmeister": patch
---

Under `with-temp-home` (`WERKMEISTER_TEMP_HOME` equal to `HOME`) or a fixture run, werkmeister no longer reaches the user's telepresence daemon. `infra intercept`, `--leave` and `--status` refuse with the reason (`HOST_SESSION`) before any telepresence call, `feature down` leaves no intercept, and status reads no intercepts. The daemon runs once per user, not per HOME, so a temp HOME could switch the namespace it is connected to, detach or uninstall another workspace's intercept, or quit it (SW-1074).
