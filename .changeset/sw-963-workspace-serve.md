---
"werkmeister": minor
"werkmeister-core": minor
---

New `werkmeister workspace serve <dir>`: serves a folder inside the workspace on 127.0.0.1 at an ephemeral port (`python3 -I -u -m http.server 0 -b 127.0.0.1 -d <dir>`), and refuses one whose real path is outside it, the workspace folder itself or a dot-folder (its token and `.env` files). The ICM stage contracts name it for a static-page browser check in place of the raw `python3` line, which the autonomous deny list's `Bash(python3:*)` refused (sw-961), and every ICM run pre-approves it (SW-963).
