---
"werkmeister-core": minor
"werkmeister": minor
---

SW-249: the generated `.devcontainer/devcontainer.json` passes `CLAUDE_CODE_OAUTH_TOKEN` from the host at every attach (`remoteEnv`, `${localEnv:CLAUDE_CODE_OAUTH_TOKEN}`), so a container started with a `claude setup-token` token set needs no Claude login, and no generated file holds the token. Every workspace's container now mounts one shared `~/.claude` volume, `werkmeister-claude-home`, so you log in once; each container still reaches only its own workspace, because the werkmeister registration lives outside the volume and sends that workspace's token. Close-out never removes the shared volume. The per-workspace `features-claude-home-<workspace>` volumes from 0.54.0 are no longer used; drop them with `docker volume rm`.
