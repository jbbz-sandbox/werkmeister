---
"werkmeister-core": patch
---

A feature the scheduler started less than 5 minutes ago is no longer preempted by another agent's start (SW-989). Before, a grant pass started the queue head and then the next head stopped it at once: its session had not had a turn yet, so it ranked idle, and over-budget autonomous features rotated every 2-3 minutes without one finishing. Inside the hold it ranks working, so only a person's start can stop it. Each preemption now writes a `queue.preempt` event to the metrics log with the stopped feature, its rank and the feature it made room for.
