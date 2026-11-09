# Issue trackers

A workspace starts from an issue, and agents file the bugs they find, in the machine's
issue tracker: Jira or GitHub Issues. This page covers how to connect each one. For issue
refs, projects and the `werkmeister issue` commands, see the
[Configuration § Issue tracker](configuration.md#issue-tracker).

## What machine setup asks

`werkmeister machine setup` section **5. Issue tracker** asks one question: `jira` or `github`
(the default is your current answer, or `jira` on a first run). The answer goes to `overrides.issue_tracker` in
`~/.werkmeister/config.yaml`. What it asks next depends on that answer:

- **`github`**: nothing more. It uses the GitHub org from section 1 (`overrides.github_org`)
  and tracks issues in every registry repo under that org. Sign-in comes from `gh`; see
  [GitHub Issues](#github-issues-gh-auth).
- **`jira`**: it asks "Configure Jira credentials now?" (optional, default no). If you say
  yes, it asks for the Jira base URL, your Atlassian login email and an API token, and
  writes them to the `jira:` section. When all three are already set, it prints
  `Already configured for <email>` and asks nothing; to replace a token, edit the config
  file. See [Jira](#jira-api-token).

`werkmeister infra connect` then checks sign-in for each project's tracker, with a line
like `issue tracker · GitHub · not signed in — run: gh auth login`.

## Jira (API token)

An optional Jira API token lets Werkmeister read and write Jira over REST directly
(status pills, issue cards, briefings, `issue create`, status moves) instead of a
`claude -p` round-trip through the Atlassian MCP. `werkmeister issue ready` needs it.

Only step 1 is manual. Machine setup writes step 2 for you, and
`werkmeister infra connect` runs step 3 against `/rest/api/3/myself`. With no
credentials, reads go through the Atlassian MCP. Only placeholder values, or a token
Jira rejects, are reported as a fault.

### Steps

1. **[manual] Create an Atlassian API token**
   - Open <https://id.atlassian.com/manage-profile/security/api-tokens>
     (log in with the Atlassian account you use for your Jira site, e.g.
     your-org.atlassian.net).
   - Click **Create API token** (the plain one, *not* "with scopes": the
     unscoped token works with all REST endpoints we use).
   - Name: `werkmeister-jira` (anything memorable). Expiry: max is 1 year. Note
     the date, because you'll repeat this step then.
   - Copy the token immediately (it is shown once).

2. **Add the credentials** to `~/.werkmeister/config.yaml` (or answer
   `werkmeister machine setup`'s prompts):

   ```yaml
   jira:
     base_url: https://your-org.atlassian.net
     email: <your-atlassian-login-email>
     api_token: <paste-token-here>
   ```

   `email` is the address on your Atlassian *account*. Email aliases may
   authenticate too, but use the canonical one if in doubt. Check your
   avatar menu in Jira.

3. **Verify** (scriptable; this is the health check):

   ```bash
   curl -s -u "<email>:<api_token>" \
     "https://your-org.atlassian.net/rest/api/3/myself" | jq '{displayName, emailAddress}'
   ```

   If your display name comes back, it works. A `401` mentioning policy means the org
   has disabled API tokens through an SSO policy. Werkmeister then falls back to Jira
   through the local `claude` CLI and the Atlassian MCP, so nothing breaks, but you
   don't get the fast path.

### How it's consumed

`packages/werkmeister-core/src/jira-rest.ts` reads `JIRA_BASE_URL` / `JIRA_EMAIL` /
`JIRA_API_TOKEN` from the process env first, then from the `jira:` section of
`~/.werkmeister/config.yaml`.
When credentials are absent or a call fails, every caller falls back to the
original `claude -p` (Atlassian MCP) path.

Endpoints used (API v2, which returns rich-text fields as plain wiki-markup
strings; v3 returns ADF JSON we'd have to walk):

- `GET /rest/api/3/myself`: verify only
- `GET /rest/api/2/issue/<KEY>?fields=…`: issue card, briefing, form prefill
- `GET /rest/api/2/search/jql?jql=key in (…)&fields=status`: batch status
  lookup (the old `/rest/api/2/search` endpoint is deprecated/removed; use
  `/search/jql`)
- `GET /rest/api/2/issue/createmeta/<PROJECT>/issuetypes`, `POST /rest/api/2/issue`:
  `issue create`
- `GET`/`POST /rest/api/2/issue/<KEY>/transitions`, `POST …/comment`: status
  moves and comments

### Renewal

Tokens expire (max 1 year). Symptom: Jira status pills and cards quietly fall
back to the slow path, or the server log shows a `401`. Fix: repeat step 1, then paste
the new token into `jira.api_token` in `~/.werkmeister/config.yaml`.

## GitHub Issues (`gh auth`)

GitHub Issues needs no token in Werkmeister's config. Every call goes through the
GitHub CLI, so the sign-in is `gh`'s own:

```bash
gh auth login                       # once per machine
gh auth status --hostname github.com
```

An issue ref is `owner/repo#n`, and new issues are filed in the registry repos under
`overrides.github_org`. `werkmeister infra connect` checks two things, and prints the
fix for each:

| Check | Fails as | Fix |
|---|---|---|
| `gh auth status --hostname github.com` | `not signed in` | `gh auth login` |
| `gh repo view <repo>` for each tracked repo | `can't read <repo>` | `gh auth refresh -s repo` |

A GitHub Projects board (`werkmeister issue ready` on a project with a board) also needs
the `read:project` scope: `gh auth refresh -s read:project`.
