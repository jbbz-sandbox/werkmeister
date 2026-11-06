---
"werkmeister": patch
---

A `pr watch` wake write that fails (disk full, permissions) no longer loses a wake already held for the session: the held wake is put back and the error still surfaces. (SW-502)
