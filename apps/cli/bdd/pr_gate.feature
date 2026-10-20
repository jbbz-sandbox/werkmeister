Feature: PR gate runs only the tests a change can break
  Before a workspace opens a pull request, `werkmeister pr gate` checks it.
  It runs a service's tests only when the branch changes that service's files,
  so a docs-only change ships without waiting on a test suite.

  Rule: a change to docs alone runs no service tests

    Scenario: an approved docs-only change passes the gate
      Given an approved workspace whose branch changes only "docs/guide.md"
      When the PR gate runs
      Then the gate passes
      And no service tests ran

  Rule: a change to a service's files needs that service's tests

    Scenario: a code change with no way to run its tests is held
      Given an approved workspace whose branch changes only "src/index.ts"
      When the PR gate runs
      Then the gate fails on the tests for "app"
