## Description

**What it does:**

1. Lists the files in `~/.werkmeister/tokens` whose name is not a folder under the workspaces root (`paths.workspaces_root`)
2. With `--remove`, deletes them. A workspace's own token is never touched

Without `--remove` nothing changes. If the workspaces root cannot be read or holds no workspace folder, nothing is removed and the command exits 1.

**When to use:**
- Once after upgrading past 0.74.0: core tests that ran before SW-433 left tokens there (see the release notes for the name prefixes)
- After deleting a workspace folder by hand

A removed token is minted again by the next `werkmeister workspace init` for that workspace.

A workspace that lives outside the workspaces root counts as stale: keep `paths.workspaces_root` correct before using `--remove`.
