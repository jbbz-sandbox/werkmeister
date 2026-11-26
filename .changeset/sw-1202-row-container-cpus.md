---
"werkmeister-core": patch
---

`werkmeister-context.md` § Test commands says each line runs in the container it names, and each `with-temp-home` line sets `WERKMEISTER_ROW=<container>:<cpus>`. `with-temp-home` prints a warning naming the row's own container when it runs in a container with fewer CPUs (cgroup v2 `cpu.max`), as when the core row ran 16 min in a 1-CPU container against 4–6 min in its own. Rerun `werkmeister workspace init` to regenerate the file and the wrapper (SW-1202).
