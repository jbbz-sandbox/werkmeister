---
"werkmeister-core": patch
"werkmeister": patch
---

SW-262: the PR gate's host-load wait is one 10 min budget for the whole run, shared by lint, each test and the release check, instead of up to 30 min before each one. Before it waits, `pr gate` / `pr open` says how long it may wait (`waiting up to 10 min for host load …`) and prints a `still waiting …` line each minute; once the budget is spent the remaining checks run at once and their rows say so. `werkmeister internal wait-load` (run by `with-temp-home`) waits up to 10 min the same way. `_shared/pr-rules.md` rule 3 and the 04_propose contract now say to run `pr open` detached with `nohup … ; echo "exit $?" >> .werkmeister/pr-open.log` and read the log to the `exit` line (SW-266, SW-273, SW-298).
