---
"werkmeister": patch
---

`werkmeister machine clean` now removes the host-load probe containers a killed `docker run` left Created or exited (SW-969). The probe (macOS and Windows) is labelled `com.werkmeister.role=vm-load`, so its leftovers can be told apart on the shared daemon.
