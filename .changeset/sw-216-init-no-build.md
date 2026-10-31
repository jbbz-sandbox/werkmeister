---
"werkmeister": minor
---

SW-216: `werkmeister workspace init --no-build` (old spelling `init-workspace`) writes compose.yml and the context files but skips the `docker compose up --build --no-start` image build, so a built-CLI exercise against a fixture makes no docker call. The default is unchanged. The `cli` and `werkmeister-core` validate text names the flag.
