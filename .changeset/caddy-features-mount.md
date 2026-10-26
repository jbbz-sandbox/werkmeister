---
"werkmeister-core": patch
"werkmeister": patch
---

SW-100: Caddy starts on a fresh clone, a git worktree or an npm install. The generated `features.json` was file-bound inside the read-only `proxy/ui` mount, so Docker needed a gitignored `apps/cli/infra/proxy/ui/features.json` to exist as the mountpoint, and only old checkouts with a stale copy had one. It now mounts at `/srv/features.json`, and the Caddyfile's `/__werkmeister/features.json` handle serves it from there. The next `connect` / `up infra` regenerates the Caddyfile and recreates Caddy on the new mount. A leftover `apps/cli/infra/proxy/ui/features.json` in an old checkout is no longer read and can be deleted.
