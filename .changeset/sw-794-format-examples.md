---
"werkmeister-core": patch
---

SW-794: the SDK docs' `@example` code is formatted like the rest of the repo (biome: 2 spaces, 100 columns). `pnpm run format:examples` formats every `@example` block in werkmeister-core's sources, and `docs:sdk` fails on one it would change; a block biome cannot parse is left as written.
