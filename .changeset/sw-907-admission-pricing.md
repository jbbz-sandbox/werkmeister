---
"werkmeister": patch
---

Capacity admission no longer lets three kinds of start past the budget. A plain `feature up` beside a running on-demand service prices every `up` service it starts, not its set less what runs. A running feature costs at least what its compose reserves for its running services, so a container started with no or lower limits no longer reads as free. An admitted start is reserved in `~/.werkmeister/scheduler/starting.json` until its containers run (or for 10 minutes), so two admits before either one's containers exist can't both take the same room (SW-907).
