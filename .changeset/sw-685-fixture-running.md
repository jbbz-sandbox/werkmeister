---
"werkmeister": patch
"werkmeister-core": patch
---

`with-fixture-workspace` takes `--running <file>` and `--queue <feature>[,<feature>]...`, so a capacity wait runs through the built CLI. Each `--running` line (`feature<TAB>workspace<TAB>startedAt<TAB>memoryBytes<TAB>nanoCpus`) is a container the fixture's fake `docker ps -q` / `docker inspect` show the scheduler as running; the workspace is a folder name created empty in the fixture, so the holder is a person's and never preempted. `--queue` seeds `scheduler/queue.json`. With `--config` `budget: { cpus: 6 }` and a 6-CPU holder, `feature up` exits 75 naming the holder, and `budget status` lists it under Running. `withFixtureWorkspace` takes the same as `containers` and `queue`.
