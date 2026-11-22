---
"werkmeister-vscode": patch
---

The top of the VS Code workspaces view is one pinned status strip of at most 2 rows (SW-1009): chips for what needs you (with the oldest one's age), running, waiting, infra, red CI or conflicts, each shown only when above zero and linking to the first card it counts, then the host line with a two-tone meter. It stays in place while the cards scroll. The Master control and Host cards are gone: Foreman (the renamed Master control terminal, which still finds an open `Master control` terminal), Dashboard and the Jira board are title-bar icons, the board icon only when a board is configured. Refresh PRs, Connect infra and Legend moved to the `…` menu. The view's badge shows how many workspaces need you.
