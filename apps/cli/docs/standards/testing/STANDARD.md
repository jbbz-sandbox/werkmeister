---
domain: testing
applies_to:
  - "**/*.spec.ts"
  - "**/*.test.ts"
  - "**/e2e/**"
  - "**/__tests__/**"
  - "**/*_test.py"
phase: [implement, review]
task_signatures:
  - "unit test"
  - "unit-test"
  - "integration test"
  - "contract test"
  - "e2e"
  - "mocking"
  - "test coverage"
  - "jest"
  - "vitest"
  - "pytest"
summary: Test boundaries in a distributed system — unit vs integration vs contract tests, what to mock at a service seam.
---

# Testing standard

Where to draw test boundaries in a system of cooperating services. The shared
comment rubric ([comments.md](comments.md)) applies in full.

## Rules

- **Test at the right seam** — unit-test pure logic in isolation; integration-test
  a service against its real dependencies via the sandbox; never mock the thing
  actually under test.
- **Contract over end-to-end for cross-service** — assert the boundary contract
  (schema / DTO shape) rather than a brittle full-stack path when a focused
  contract test would catch the same regression.

## Don't

- Don't mock the unit under test to make a test pass — you are then testing the
  mock, not the code.
