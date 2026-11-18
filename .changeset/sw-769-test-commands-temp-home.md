---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister-context.md` § Test commands now prints the test of a container that holds the real `~/.werkmeister` or the docker socket, and mounts the workspace folder at its host path, under the temp HOME: `docker exec -w /app <container> <ws>/.werkmeister/bin/with-temp-home --no-wait sh -c '…'`, as its Validation text requires. Other containers (a docker.sock-only one cannot see `<ws>/.werkmeister/bin`) keep the bare `docker exec` line, and the allow rules are unchanged. Rerun `werkmeister workspace init` to regenerate the file.
