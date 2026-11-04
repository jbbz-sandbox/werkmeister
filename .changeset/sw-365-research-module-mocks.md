---
"werkmeister": patch
---

The ICM research stage greps the tests for whole-module mocks (e.g. `vi.mock("<module>"`, `mock.module`) of each module the change adds an export to, and lists every hit as a fixture to update (SW-365).
