## Description

**What it does:**

1. Leaves any k8s intercepts the feature holds (best effort; teardown never waits on Telepresence)
2. Stops all Docker containers for the feature (`docker compose down --remove-orphans`)
3. Releases the slot back to the pool, and clears any pause or capacity wait
4. Starts queued features that now fit in the freed budget
5. Regenerates the Caddyfile (removing this feature's routing rules) and reloads Caddy if running

The feature's generated files (`compose.yml`, `.env`, `.werkmeister/`) are left in place in its workspace — they're overwritten on the next `werkmeister feature up`.

By default, per-feature Docker volumes (node_modules, build caches) are preserved so the next `werkmeister feature up` is faster. Use `--volumes` to remove them for a full cleanup.

The command is safe to run even if the feature is already stopped — it will clean up any leftover state.
