---
"werkmeister": patch
"werkmeister-core": patch
---

SW-343: `machine setup` without a TTY (or with `--yes`) now reports the skipped CA trust and /etc/hosts as ⚠ with the command to finish, and ends with "Setup incomplete" instead of "Machine is set up."
