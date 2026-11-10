---
"werkmeister": patch
---

SW-630: `feature up`, `feature up --service` and the gate's container starts wait up to 90 s on `budget.host_load` before compose starts a setup service (the install), and say so. If load is still over the limit after that, they fail with `HOST_LOAD` and the load in the message, instead of a 20-minute compose timeout and an install that ends with exit 137. They don't wait on macOS (SW-556: its load average is no signal), when `WERKMEISTER_NO_WAIT=1` is set, or when the gate starts a service `--no-deps` because its install is current.
