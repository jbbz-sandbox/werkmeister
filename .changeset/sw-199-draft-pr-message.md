---
"werkmeister-core": patch
"werkmeister": patch
---

SW-199: `pr open` with PR files that exist but are not approved now lists each file and its status (`pr-app.md is at status: draft; set status: approved to open it.`) instead of telling the person to write a file that is already there. "No matching PR file … Write …" is kept for a workspace with no PR files.
