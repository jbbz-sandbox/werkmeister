---
"werkmeister-core": minor
"werkmeister": minor
---

SW-341: `werkmeister feature up` (including `--service`) and `werkmeister infra proxy-reload` now resolve every routed hostname after regenerating the Caddyfile and warn about any that does not resolve to 127.0.0.1 on this machine, printing the exact `echo "127.0.0.1 <hosts>" | sudo tee -a /etc/hosts` line and pointing at `werkmeister machine setup`. The command still succeeds.
