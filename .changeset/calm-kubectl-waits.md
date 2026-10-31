---
"werkmeister-core": patch
---

SW-260: give `refreshKubeconfig`'s local `kubectl` calls 30 s and 15 s instead of 10 s and 5 s, so a loaded host no longer reports a missing kubeconfig.
