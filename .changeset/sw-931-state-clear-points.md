---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix reproduce contract now asks a fix that adds persisted state (a file, a record field, a marker) to list each write and each clear point (success, failure, the other entry points to the same lifecycle) and give each clear point a test (SW-931).
