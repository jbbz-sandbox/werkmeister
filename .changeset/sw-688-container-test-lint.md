---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister-context.md` § Test commands prints each running service's `docker exec` test line with the repo's `lint:` appended (`… sh -c '<test> && <lint>'`), as the host test line already does. An implement stage that runs its tests in the container now catches a `docs:check` or format failure there, not first at `werkmeister pr gate`. The lint-tailed line is not pre-approved, since a service container can hold the Docker socket and the real `~/.werkmeister`: Claude Code asks before each run.
