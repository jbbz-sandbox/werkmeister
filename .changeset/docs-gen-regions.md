---
"werkmeister": patch
---

SW-81: a hidden `werkmeister __reference` prints the commands and options as JSON. `pnpm run docs:gen` builds the users-guide command list from it, and `docs:check` reads it for the flag check.
