---
"werkmeister": patch
---

SW-546: a service start that does not fit the budget (the pr gate's starts, `pr open`, `feature up --service`) now stops the containers of features whose session is idle or parked on a question, oldest first, instead of waiting 10 min behind them and failing. A person's workspace counts once its session is waiting on a person. The victims are queued as preempted and come back when room frees; the output names each one and why. `budget.preempt: false` turns it off.
