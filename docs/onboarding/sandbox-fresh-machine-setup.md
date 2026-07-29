# Developer-Sandbox — fresh-machine setup (Claude-driven)

This document has two parts:

1. **For the human (you):** three manual steps to get Claude Code pointed at the prompt.
2. **The setup prompt:** hand this to Claude Code; it drives the rest, pausing to ask
   you for the few things only a human can provide (credentials, secrets, a sudo password).

Intended for someone setting up the sandbox for the **first time** — no prior version installed.

---

## Part 1 — Human steps (do these yourself)

```bash
# 1. Clone the repo
git clone https://github.com/sandbox/sandbox.git
cd sandbox

# 2. Switch to the multi-feature branch (REQUIRED — see note below)
git checkout multi-feature

# 3. Launch Claude Code in this directory, then paste the prompt in Part 2
#    (or say: "follow docs/onboarding/sandbox-fresh-machine-setup.md")
claude
```

> **Why multi-feature?** This branch is permanent and never merges to `main`. The entire
> slot/Caddy architecture, the `sandbox-tools` plugin marketplace, and every command the
> setup uses live **only** here. `main` is a different (nginx) architecture with none of it.

Have these ready before you start — Claude will ask for them:

- **Google Cloud login** for the `tr-dev` project (you'll run `gcloud auth login` interactively).
- **The sandbox secrets** (`~/.sandbox/secrets.env` values) — get them from a teammate or the
  team's secret store (1Password / vault). Claude cannot invent these.
- **Your Mac password** once, for the `/etc/hosts` edit (local dev domains).

---

## Part 2 — The setup prompt (give this to Claude)

> You are automating a **first-time** setup of the Sandbox sandbox on this
> machine. Work through the phases below **in order**, running each command and showing me
> its output. This is a fresh machine with no previous sandbox version.
>
> **Hard rules:**
> - Everything runs from the repo root on the **`multi-feature`** branch. Before doing
>   anything, run `git branch --show-current` and confirm it prints `multi-feature`. If it
>   doesn't, STOP and tell me.
> - All commands use the `./sandbox` wrapper (it resolves a node runtime and execs the
>   compiled CLI — run `npm install && npm --prefix apps/cli run build` once first).
>   Target cluster is **dev only**.
> - When you need something only I can provide — an interactive login, a secret value, a
>   sudo password, or a path choice — **STOP and ask me a specific question**, then continue.
>   Do not guess secrets or paths.
> - If a step fails, diagnose it (use the `sandbox-diagnose` skill and `docs/known-issues.md`)
>   before moving on. Don't paper over a failure to reach the next phase.
>
> ### Phase 0 — Preflight
> Check that these are installed and report a table (present/version): `git`, `node`
> (20+), `npm`, `docker`, `kubectl`, `gcloud`, `openssl`, and `claude`. Then check:
> - **Docker is running** (`docker info` succeeds). If not, ask me to start Docker Desktop.
> - **gcloud is authenticated** (`gcloud auth list`) and the active project is the dev
>   project (`tr-dev-361214`). If not authenticated, ask me to run `gcloud auth login` and
>   `gcloud auth application-default login`, then re-check.
> - **kube context** `gke_tr-dev-361214_us-central1_tr-dev-gke` exists
>   (`kubectl config get-contexts`). If missing, tell me the `gcloud container clusters
>   get-credentials` command to fetch it and ask me to run it.
>
> Do not proceed past Phase 0 until Docker is up and gcloud is authenticated.
>
> ### Phase 1 — Global config
> Run `./sandbox config`. It's an interactive wizard that writes `~/.sandbox/config.yaml`
> (the single source of truth), regenerates `~/.sandbox/env.sh`, adds a managed source-block
> to `~/.zshenv`, and cleans any stale env block from the Claude Desktop config. It asks for
> two paths — **repos root** (where source repos live, default `~/workspace`) and
> **workspaces root** (where feature worktrees go, default `~/workspace/features`). Ask me
> which paths to use, or confirm the defaults, before running it. After it finishes, run
> `source ~/.zshenv` (or note that a new shell is needed) and `./sandbox config --check` to
> confirm it's in order.
>
> ### Phase 2 — Machine prerequisites
> Run `./sandbox setup`. This installs the `sandbox-tools` plugin (from the multi-feature
> marketplace) and the `ponytail` plugin, clones the companion `sandbox-workspace` repo under
> the repos root, scaffolds an optional Jira token file, and reports Telepresence state
> (optional — only needed for `sandbox intercept`; skip unless I ask). Then run
> `./sandbox setup --check` and show me the report. Note that plugin changes only apply to
> **new** Claude Code sessions.
>
> ### Phase 3 — Secrets
> The shared infra needs `~/.sandbox/secrets.env`. Check whether it exists and is filled.
> If not:
> 1. Show me the required keys (from `infra/config/secrets.env.example`).
> 2. Copy the example to `~/.sandbox/secrets.env` and `chmod 600` it.
> 3. **Ask me for the values** (I'll paste them from our secret store) and fill them in —
>    or tell me to fill the file myself and confirm when done.
> Never commit this file or echo secret values back in full.
>
> ### Phase 4 — Local TLS certs + hosts entries
> Run `./bin/generate-certs.sh`. It creates a self-signed cert in `~/.docker/certs` and adds
> the `*.local.sandbox.com` dev domains to `/etc/hosts`. The `/etc/hosts` edit needs
> sudo — warn me it will prompt for my password. It's idempotent (safe to re-run).
>
> ### Phase 5 — Bring up shared infrastructure
> Run `./sandbox connect`. This starts redis, cloud-sql-proxy, gke-forwards, the Cloudflare
> Worker, and Caddy, and launches the dashboard MCP web server. It needs Docker running,
> gcloud creds, the secrets from Phase 3, and a `cloudflare-workers` repo checkout under the
> repos root — if that repo is missing, tell me to clone it
> (`https://github.com/sandbox/cloudflare-workers.git`) and re-run. Show me the health
> summary; every service should read healthy.
>
> ### Phase 6 — Verify
> Run and report: `./sandbox config --check`, `./sandbox setup --check`, and
> `./sandbox status`. Then tell me to open **https://sb-web.local.sandbox.com/__sandbox/**
> in a browser to confirm the feature selector loads. Finish with a short summary: what's
> configured, anything left for me to do (e.g. optional Jira token, optional Telepresence),
> and the command to bring up a first feature (`./sandbox up <feature>`).

---

## Notes for the human

- **New shell after Phase 1.** The `SANDBOX_*` exports land in `~/.zshenv`; open a fresh
  terminal (or `source ~/.zshenv`) so later commands and MCP servers see them. Put sandbox
  env vars in `~/.zshenv`, **not** `~/.zshrc` — `.zshrc` isn't read by non-interactive shells
  (Claude's Bash tool, MCP servers), which breaks the sandbox silently.
- **Plugins need a new Claude session.** `sandbox setup` installs plugins into user scope,
  but a running Claude session keeps the snapshot it launched with. Restart Claude after
  Phase 2 to pick up the `sandbox-tools` skills.
- **Optional bits are genuinely optional.** A missing Jira token just falls back to the
  slower `claude -p` path; Telepresence is only for `sandbox intercept`. Neither blocks a
  working sandbox.
- **Source repos.** `sandbox connect` needs the `cloudflare-workers` repo under your repos
  root. Bringing up a feature (`sandbox up`) needs the relevant service repos there too —
  clone the ones you plan to work on.
