---
"werkmeister-core": patch
---

When `pr gate` or `pr open` auto-rebases onto a base that changed a lockfile (`pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock` and other common ones), the `base` row names it and says to reinstall in the container before running a test row by hand: `werkmeister feature up` reruns the install. The gate's own rows already reinstall after the rebase (SW-1181).
