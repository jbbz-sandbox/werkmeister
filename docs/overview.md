# Overview

Autonomous where it can be. Human where it must be.

One agent per ticket, each in its own git worktree and containers. Bring your harness (Claude Code, OpenCode or Codex), any OCI container manager, and your tracker (Jira, GitHub Issues, or your own).

Each ticket gets a workspace: a git worktree on its own branch, containers for the services the ticket changes, and routing through a local proxy that sends your browser to those containers. Each kind of work (a bug, a feature, a spike) has its own stages. The agent works through them on its own and stops at a gate when a person has to decide. [The UIs](uis.md) show which workspace is waiting on you.

## What it runs on

- A harness: Claude Code, OpenCode or Codex ([Harnesses](harnesses.md)).
- Any OCI container manager with Docker Compose v2: Docker Engine, OrbStack, Docker Desktop or another.
- git, and Node.js 22 or later.
- An issue tracker: Jira, GitHub Issues, or your own ([Issue trackers](issue-trackers.md)).
- Kubernetes is optional. A service you don't run locally can come from a cluster, a remote host, or nowhere: see [Without Kubernetes](topology.md#without-kubernetes).

## Get started

```bash
cd ~
npx werkmeister machine setup
```

It installs werkmeister from npm, then asks for your repo and workspace folders, the ingress domains, your repos' services and your issue tracker. Then it sets up the Claude Code plugins, a TLS certificate and the `/etc/hosts` entries. The [Quick Start](quick-start.md) goes from there to a closed workspace.

## Where next

| Page | Read it for |
|---|---|
| [Quick Start](quick-start.md) | your first workspace, start to finish |
| [Users guide](users-guide.md) | day-to-day workflows |
| [Concepts](concepts.md) | features, workspaces, the proxy and the baseline |
| [Architecture](werkmeister-architecture.md) | how the pieces fit |
| [Why Werkmeister](why.md) | why it exists |
