## Description

On a terminal, streams logs in real time (equivalent to `docker compose logs -f --tail 100`); press `Ctrl+C` to stop. Without one (a pipe, a script, an agent's tool call), it prints the last 100 lines of each container and returns.

```bash
# All services
werkmeister feature logs my-feature

# Just frontend
werkmeister feature logs my-feature frontend
```
