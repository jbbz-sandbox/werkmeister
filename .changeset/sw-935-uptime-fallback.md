---
"werkmeister": patch
---

`with-temp-home`'s failure line no longer prints `uptime: not found` in slim images without procps: it reads the load from `/proc/loadavg` when `uptime` is missing, and leaves the load out when neither exists (SW-935).
