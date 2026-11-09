---
name: setup
description: Use when someone is setting up werkmeister for the first time or on a new machine - "set up werkmeister", "get me started with werkmeister", "install werkmeister on a new machine", "/werkmeister:setup", "add my first repo", or there is no ~/.werkmeister yet.
---

# Set up werkmeister

Take the person from nothing to their first workspace. You run each step with them; they answer the questions. Go in order: each step needs the one before it. The one exception is a machine that is already set up (see below).

New machine? This skill comes with the werkmeister plugin, which isn't installed yet. In Claude Code run `claude plugin marketplace add jbbz-sandbox/werkmeister && claude plugin install werkmeister@werkmeister`, restart it, then `/werkmeister:setup`.

Never move, rename or delete an existing `~/.werkmeister`. If one is there, the machine is already set up: **skip step 2**. Run `werkmeister machine setup --check`, fix only what it reports, then go to step 3. Re-running the wizard rewrites the machine config and restarts the host daemon every workspace uses.

## 1. Check the prerequisites

Run all four checks, then show the results as one table:

| Need | Check | Passes when |
|---|---|---|
| a harness | `command -v claude opencode codex` | it prints at least one path; judge by the output, not the exit code (the plugin step of machine setup needs `claude`) |
| git | `git --version` | it prints a version |
| Node.js 22 or later | `node -v` | the major version is 22 or more |
| a container manager with Compose v2 | `docker info >/dev/null && docker compose version` | both succeed |

If any row fails, **stop here**. Don't run machine setup: it would fail partway through. For each missing one, say what it is and how to install it:

- Claude Code: <https://docs.claude.com/en/docs/claude-code/setup> (OpenCode and Codex also work, see werkmeister's Other harnesses page)
- git: `xcode-select --install` on macOS, `sudo apt install git` on Debian/Ubuntu
- Node.js 22: <https://nodejs.org>, or `nvm install 22`
- Containers: OrbStack or Docker Desktop on macOS; Docker Engine with the compose plugin on Linux (<https://docs.docker.com/engine/install/>). If `docker` exists but `docker info` fails, the daemon isn't running: start it.

Ask them to run this skill again once they're installed. Kubernetes is optional; don't check for it.

## 2. Run machine setup

From the home folder, never inside a werkmeister checkout (npx would run that checkout's CLI and install nothing):

```bash
cd ~ && npx werkmeister machine setup
```

It's interactive and asks for a sudo password, so the person runs it in their own terminal (in Claude Code: type `! cd ~ && npx werkmeister machine setup` so the output lands here). Before they start, tell them what it will ask, in this order:

| It asks | What it means |
|---|---|
| repo and workspace folders, workspace record repo | where your repos are cloned (`~/repos`), where workspaces go, and the git repo that keeps each workspace's record |
| browser | what `werkmeister feature open` opens |
| ingress domain | the local domain your services answer on; changing it rewrites the TLS certificate and `/etc/hosts` |
| clone the demo apps? | two small apps (backend, frontend) to try things with; say yes if you have no repo ready |
| kube context | only for `werkmeister infra intercept`; leave the default if you don't use Kubernetes |
| issue tracker (and Jira credentials) | where your issues live, GitHub or Jira; for Jira it asks for a login and links you to where to make an API token |
| telepresence, superpowers plugin, VS Code settings and extension, standards folder, PR watch, background daemon | optional extras; the default is fine to start |
| sudo password | to trust the TLS certificate and add the `/etc/hosts` entries |

Answer their questions as each one comes up. When it ends, run `werkmeister machine setup --check` and show the result. Fix anything it reports before going on.

## 3. Add their repos

Ask which repos they want to use (or "the demo apps" if they cloned those in step 2). The demo apps are already registered: check with `werkmeister registry` and go to step 4.

For each other repo, fetch the current steps first, since they change: <https://raw.githubusercontent.com/jbbz-sandbox/werkmeister/main/docs/repo-setup.md> (published at <https://werkmeister.io/docs/repo-setup>). Then go through its Steps with the person, one at a time:

- Steps 1–4 (clone, detect, fix up, `registry sync`): do them. At step 3, go down the page's **Checklist** item by item against the new `.werkmeister/services.yaml`, and show the person every `# guessed:` value before you keep it.
- Step 5 (prove it runs) is step 4 below.
- Step 6 (commit the fragment) is the person's call: offer to commit it, don't push.

A repo is done when `werkmeister registry --check` prints "Registry is up to date." and its services show in `werkmeister registry`.

## 4. Create the first workspace

```bash
werkmeister workspace new <name> --services <service,...>
```

For the issue, model and other options, use the `workspace` skill rather than guessing flags. Then, from the new folder, run `werkmeister feature up` and open each service with a `feature_router:` at `https://<service>.<local_domain>`.

Tell the person the folder it created and how to open it: `cd <folder> && claude`, or press Start on its card in the `/workspaces` pane.

## 5. Finish

Summarise the three things that make setup done, each with what showed it:

- machine setup: `werkmeister machine setup --check` is clean
- repos: the ones now in `werkmeister registry`
- workspace: its folder, and that `feature up` started it
