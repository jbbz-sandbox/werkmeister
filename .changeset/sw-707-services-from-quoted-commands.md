---
"werkmeister": patch
"werkmeister-core": patch
---

`workspace new` no longer takes services from a command or log quoted in the issue: it ignores code blocks, indented lines and command-shaped `{{…}}`/backtick spans, maps a named code path (`packages/werkmeister-core/src`) to its service, and reads the starting prompt only when the issue names none.
