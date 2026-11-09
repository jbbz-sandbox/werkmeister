# Werkmeister — User's Guide

Autonomous where it can be. Human where it must be.

One agent per ticket, each in its own git worktree and containers. Bring your harness (Claude Code, OpenCode or Codex), any OCI container manager, and your tracker (Jira, GitHub Issues, or your own). The CLI is `werkmeister`, or `w9r` for short.

This guide covers the day-to-day workflows. New here? Start with the [Quick Start](quick-start.md). [Before you start](quick-start.md#before-you-start) lists what you need: a harness, a container manager, git and Node.js 22 or later. Kubernetes is optional: see [Without Kubernetes](topology.md#without-kubernetes).

## The docs, page by page

| Page | Holds |
|---|---|
| [Quick Start](quick-start.md) | machine setup to a closed workspace, with the prerequisites |
| [Concepts](concepts.md) | features and workspaces, slots, the k8s baseline, the Caddy proxy, isolation |
| [CLI reference](cli-reference.md) | every command and option |
| [Configuration](configuration.md) | the registry, ports, config and generated files, environment variables, paths |
| [Setting up a repo](repo-setup.md) | adding a repo, step by step |
| [Registry fragments](registry-fragments.md) | a fragment's fields, `test:` and `validate:` |
| [Troubleshooting](troubleshooting-advanced.md) | when something is broken |
| [Architecture](werkmeister-architecture.md) | how the pieces fit, with diagrams |

## Installation

```bash
cd ~
npx werkmeister machine setup
```

It installs the CLI globally from npm and runs setup. See the [Quick Start](quick-start.md). To build it from source, see [Contributing](contributing.md).

### Required Environment Variables

Create a `.env` file in the repository root (see `.env.example`):

```bash
# Optional — only needed by services that use them. The demo services
# (backend, frontend) require none.
GITHUB_AUTH_TOKEN=ghp_...          # npm registry access for private packages
```


## Workflows

### Starting a New Feature

```bash
# 1. Ensure k8s baseline is running
werkmeister infra connect --k8s
werkmeister infra status

# 2. Create your workspace directory (skip if your agent runner already did)
mkdir -p ~/workspace/my-feature
cd ~/workspace/my-feature

# 3. Create worktrees for the repos you'll modify
git -C ~/repos/werkmeister worktree add ~/workspace/my-feature/werkmeister feature/my-feature

# 4. Make your code changes
cd ~/workspace/my-feature/werkmeister
# ... edit files ...
git add . && git commit -m "WIP"

# 5. Start the feature
cd ~/workspace/werkmeister
werkmeister feature up my-feature

# 6. Set the feature in your browser
# Visit https://frontend.local.werkmeister.io/__werkmeister and enter "my-feature"

# 7. Develop and iterate
werkmeister feature logs my-feature
werkmeister feature restart my-feature  # after code changes if hot-reload doesn't work

# 8. Tear down when done
werkmeister feature down my-feature
```

### Adding a Service Mid-Development

If you started with just `frontend` but now need `backend` running locally:

```bash
# Check what's currently running
werkmeister feature services my-feature

# Add backend to `services` in .werkmeister/workspace.yml, then
werkmeister workspace init
werkmeister feature up my-feature

# Verify
werkmeister feature services my-feature
```

### Running Multiple Features Simultaneously

Each feature is fully isolated. Just `werkmeister feature up` each one:

```bash
werkmeister feature up my-feature    # Gets slot 1
werkmeister feature up other-feature    # Gets slot 2
werkmeister feature up third-feature    # Gets slot 3

# Check all features
werkmeister feature status

# Switch between features in the browser via the feature selector UI
# Or use different browser profiles, each with a different X-Feature cookie
#
# Easiest: open a dedicated, isolated window per feature with the cookie
# already set and the window tagged [feature] in its title + a corner badge:
werkmeister feature open my-feature
werkmeister feature open other-feature --path /categories/crm
```

### Running Playwright Tests

```bash
# Make sure the feature is running
werkmeister feature up my-feature

# Run all Playwright tests
werkmeister feature test my-feature

# Run a specific test file
werkmeister feature test my-feature -- tests/checkout.spec.ts

# Run in headed mode for debugging
werkmeister feature test my-feature -- --headed --debug
```

The test command sets `WERKMEISTER_FEATURE` and `WERKMEISTER_SLOT` in the Playwright process environment. Your Playwright config can use these to set the `X-Feature` header on all requests.

### Debugging a Service

```bash
# Tail logs for a specific service
werkmeister feature logs my-feature frontend

# Check service endpoints
werkmeister feature services my-feature

# Access the service directly (bypassing Caddy)
curl http://localhost:11101/  # frontend at slot 1, offset 1

# Access via Caddy with feature header
curl -H "X-Feature: my-feature" https://frontend.local.werkmeister.io/

# Check container status
werkmeister feature status -v

# Restart after fixing
werkmeister feature restart my-feature
```


## Cleanup & Disk Usage

Running multiple features concurrently creates per-feature Docker volumes for `node_modules` and build caches. These persist after `werkmeister feature down` (by design — to speed up subsequent `werkmeister feature up`).

**Per-feature cleanup:**
```bash
# Stop a feature and keep volumes (faster next startup)
werkmeister feature down my-feature

# Stop a feature and remove its volumes
werkmeister feature down my-feature --volumes
```

**Bulk cleanup:**
```bash
# See what's orphaned (safe — no changes)
werkmeister machine clean --dry-run

# Remove orphaned volumes and generated files from stopped features
werkmeister machine clean

# Nuclear option: tear down everything
werkmeister machine clean --all
```

**Manual volume inspection:**
```bash
# List all Werkmeister-related Docker volumes
docker volume ls | grep -E '^\S+-(backend|frontend)'

# Remove a specific volume
docker volume rm my-feature-frontend_node_modules
```

Each feature's volumes follow the naming pattern `<feature>-<volume_name>` (e.g., `my-feature-frontend_node_modules`). This ensures concurrent features never share mutable Docker state.


## Troubleshooting

See [Troubleshooting](troubleshooting-advanced.md).

## Architecture

See [Architecture](werkmeister-architecture.md).
