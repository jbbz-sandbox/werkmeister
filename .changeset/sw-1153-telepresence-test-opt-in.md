---
"werkmeister": patch
---

SW-1153: under a test runner, werkmeister's telepresence runners refuse a bare `telepresence` unless WERKMEISTER_TELEPRESENCE_BIN names an absolute stub, so a test can no longer reach the real binary and end the host's daemon.
