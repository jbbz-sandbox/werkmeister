---
"werkmeister": patch
---

`werkmeister machine detect` fits Dockerfile repos better. A single-stage Dockerfile that runs `RUN`, `COPY` or `ADD` gives `dockerfile:` and a `<repo>:local` image instead of its base image. A service with no port in any source, or whose command is `sleep infinity`, is guessed `type: cli` and marked for a person to confirm, instead of `type: api` on port 3000. A compose service with no build context is matched by its relative bind mount (`.:/app`). Validation errors print as errors under "Not written", and the report names each service with no test command (SW-928).
