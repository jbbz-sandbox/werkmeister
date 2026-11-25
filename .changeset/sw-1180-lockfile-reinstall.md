---
---

SW-1180: the werkmeister-core validate text says to rerun `pnpm install --frozen-lockfile` in the container after a rebase or pull that changes `pnpm-lock.yaml`, since the container's node_modules volume keeps the old install.
