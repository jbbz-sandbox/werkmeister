---
"werkmeister": minor
---

SW-180: `werkmeister --help` groups its commands (Everyday first, Internal last), and each command's `--help` ends with its long help from `apps/cli/src/commands/<command>.help.md`. The same files generate the users guide's command reference and new man pages (`man werkmeister`, `man werkmeister-up`), which a global install links. Commander is now 14.
