---
"werkmeister-core": patch
"werkmeister": patch
---

The feature implement contract now says a container start can rebuild from the working tree, so each new test must be seen failing against a build of the unfixed code (build before editing, or park the change and rebuild), and each fail-first run records which build it used (SW-875).
