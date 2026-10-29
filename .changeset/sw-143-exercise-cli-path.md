---
"werkmeister": patch
---

SW-143: every ICM exercise step (feature and refactor `implement`, bugfix/incident `exercise`) now says what to do when the change has no service to restart: build it, then exercise the built artifact as its Validation text in `werkmeister-context.md` says. The templates stay app-agnostic; how to exercise a given library or CLI comes from its service's (or archetype's) `validate:`. The werkmeister repo's own `cli` and `werkmeister-core` services now carry the full recipe there: run the built binary from a temp folder against a fixture workspace with seeded config and `WERKMEISTER_CONFIG_FILE`, write-capable commands only against the fixture, read-only ones (e.g. `werkmeister skills check`) from the real workspace. Existing workspaces pick it up after `werkmeister registry sync` and the next `werkmeister init-workspace`.
