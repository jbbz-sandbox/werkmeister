## Description

Reads all active slot assignments, regenerates `~/.werkmeister/infra/proxy/Caddyfile`, and reloads (or starts) Caddy. Useful after manual config changes or if the proxy gets out of sync.
Warns about routed hostnames that do not resolve to 127.0.0.1 on this machine and prints the `/etc/hosts` line to add.
