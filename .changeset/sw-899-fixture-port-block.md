---
"werkmeister-core": patch
---

The fixture workspace's ports (`with-fixture-workspace`, `withFixtureWorkspace`) start at 29100 instead of 39100. 39100 is inside Linux's ephemeral range, so a test server or client socket could land on it and fail the gate fixture's port check with `port 39100 held by a host process` (SW-899).
