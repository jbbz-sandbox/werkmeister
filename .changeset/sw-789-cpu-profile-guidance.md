---
"werkmeister": patch
"werkmeister-core": patch
---

SW-789: the feature pipeline's research contract (step 3) now tells a gate-, test- or build-speed ticket to sample the container cgroup `cpu.stat` `usage_usec` every 5 s across a cold run and report cores in use per phase before naming a critical path or lever. If the run holds all its CPUs, only a CPU cut shortens it, and the decision says so.
