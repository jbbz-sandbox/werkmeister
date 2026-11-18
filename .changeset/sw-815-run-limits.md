---
"werkmeister-core": patch
---

Run limits now allow `werkmeister issue create --relates <ticket>` for follow-ups a run finds, and `werkmeister feature up` when the exercise or a measurement needs the container, not only the gate. An autonomous workspace gets the matching allow rule, `issue create --relates <its issue>`, so a headless run files without a prompt; in an autonomous workspace `issue create` files only in its own issue's project and posts only a `--body-file` inside the workspace (no stdin, no path out of it) (SW-815).
