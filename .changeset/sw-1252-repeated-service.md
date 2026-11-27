---
"werkmeister": patch
---

`werkmeister feature up` refuses a repeated `--service` instead of starting only the last one named: run one `feature up --service <name>` per service (SW-1252).
