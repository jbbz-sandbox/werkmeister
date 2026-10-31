---
"werkmeister-core": patch
"werkmeister": patch
---

SW-279: a run whose `WERKMEISTER_CONFIG_FILE` is not the default `~/.werkmeister/config.yaml` (a temp-HOME fixture) no longer reloads or starts the shared `w9r-caddy`. Before, `workspace abandon` / `workspace close` on such a fixture loaded the fixture's Caddyfile into the real proxy and took routing down for every workspace. `reloadCaddy` and `startCaddy` now skip with `Caddy reload skipped (WERKMEISTER_CONFIG_FILE is not the default home)`, as they already did under `WERKMEISTER_FIXTURE=1`, so teardown, `feature up` / `down`, `infra proxy-reload` and the MCP tools all leave the shared proxy alone.
