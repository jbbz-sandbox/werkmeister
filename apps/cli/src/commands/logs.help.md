## Description

Streams logs in real-time (equivalent to `docker compose logs -f --tail 100`). Press `Ctrl+C` to stop.

```bash
# All services
werkmeister logs my-feature

# Just frontend
werkmeister logs my-feature frontend
```
