---
"werkmeister-core": patch
---

`with-temp-home` pins the daemon at `http://127.0.0.1:65535`, which is refused like a stopped daemon unless a test listener was handed that port (port 1 was rejected by fetch as a bad port), with a 500 ms retry (SW-743).
