# Quick Start

This page takes you from nothing to a closed workspace: what each step does, and where you're asked to decide.

<FlowDiagram label="The Quick Start flow" :steps="[
  { label: 'setup' },
  { label: 'workspace new' },
  { label: 'session' },
  { label: 'gate', gate: true },
  { label: 'pr open' },
  { label: 'close' },
]" />

## Before you start

- A harness: Claude Code, OpenCode or Codex (see [Other harnesses](harnesses.md)). `machine setup` installs werkmeister's plugins into Claude Code, and reports that step as failed if `claude` isn't on your PATH.
- Any OCI container manager with Docker Compose v2: Docker Engine, OrbStack, Docker Desktop or another.
- git.
- Node.js 22 or later.
- Kubernetes is optional: see [Without Kubernetes](topology.md#without-kubernetes).

The full list, with licences, is in [Third-party software](third-party.md#required-host-software).

## 1. Set up your machine

```bash
cd ~
npx werkmeister machine setup
```

It installs werkmeister globally from npm, then runs the setup wizard. The wizard asks for your repo and workspace folders, the browser, the ingress domains, your repos' services and your issue tracker. Then it sets up the rest: the Claude Code plugins, a TLS certificate and the `/etc/hosts` entries (it asks for your password for those two).

It is safe to re-run. `werkmeister machine setup --check` reports what drifted without changing anything.

::: warning
Don't run the `npx` line inside a checkout of the werkmeister repo. npx runs the checkout's own CLI instead, and nothing is installed.
:::

::: tip
To add your own repos, see [Setting up a repo](repo-setup.md).
:::

## 2. Create a workspace

```bash
werkmeister workspace new my-feature --issue-id SW-123
```

Or use the Create tab in the `/workspaces` pane (see [The UIs](uis.md)). Run it with no flags for the interactive wizard. You get a folder with its own git worktrees on a new branch, with the issue copied in.

## 3. Start a session

Open the workspace in your harness: `cd` into the folder and run `claude`, or press Start on its card in the pane. The agent reads the workspace's instructions and works through the stages.

## 4. Decide at the gate

The agent stops wherever a person has to decide: at the end of each stage, and before a PR opens. Read what it wrote, edit it if needed, then approve: set `status: decided` (a stage) or `status: approved` (a PR file), or reply in chat.

[Workspace lifecycle](workspace-lifecycle.md#the-gate) calls your approval *Approve*, and the checks that run after it *the gate*.

## 5. Open the PR

The agent runs `werkmeister pr open`, which runs the gate's checks again, pushes the branch and opens the PR. You review and merge it.

## 6. Close out

Once the change ships, the agent writes a short post-mortem, then `werkmeister workspace close` closes the issue, removes the workspace and deletes the merged branches.

## Next

- [Setting up a repo](repo-setup.md): register your own repos and their services.
- [Workspace lifecycle](workspace-lifecycle.md): every state from first commit to close-out.
- [Concepts](concepts.md), [CLI reference](cli-reference.md) and [Configuration](configuration.md): how it works, every command, and every config file.
