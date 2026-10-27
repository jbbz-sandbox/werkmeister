# Jira REST setup (API token)

An optional Jira API token lets Werkmeister read Jira over REST directly (status
pills, issue cards and briefings in `apps/werkmeister-dashboard`) instead of a
`claude -p` round-trip through the Atlassian MCP.

> **Mostly automated:** `werkmeister setup` asks "Configure Jira credentials now?" and
> writes them to the `jira:` section of `~/.werkmeister/config.yaml`;
> `werkmeister connect` live-verifies them against `/rest/api/3/myself`.
> Only step 1 below (creating the token) remains manual. The step is
> optional — with no credentials reads go through the Atlassian MCP, and only
> placeholder values or a token Jira rejects are reported as a fault.

## Steps

1. **[manual] Create an Atlassian API token**
   - Open <https://id.atlassian.com/manage-profile/security/api-tokens>
     (log in with your Atlassian account — the one you use for
     your Jira site, e.g. your-org.atlassian.net).
   - Click **Create API token** (the plain one, *not* "with scopes" — the
     unscoped token works with all REST endpoints we use).
   - Name: `werkmeister-jira` (anything memorable). Expiry: max is 1 year — note
     the date; you'll repeat this step then.
   - Copy the token immediately (it is shown once).

2. **Add the credentials** to `~/.werkmeister/config.yaml` (or answer
   `werkmeister setup`'s prompts):

   ```yaml
   jira:
     base_url: https://your-org.atlassian.net
     email: <your-atlassian-login-email>
     api_token: <paste-token-here>
   ```

   `email` is the address on your Atlassian *account*. Email aliases may
   authenticate too, but use the canonical one if in doubt — check your
   avatar menu in Jira.

3. **Verify** (scriptable — this is the health check):

   ```bash
   curl -s -u "<email>:<api_token>" \
     "https://your-org.atlassian.net/rest/api/2/myself" | jq '{displayName, emailAddress}'
   ```

   Your display name back = working. A `401` mentioning policy = the org has
   disabled API tokens via SSO policy; Werkmeister then falls
   back to its previous path (Jira via the local `claude` CLI + Atlassian
   MCP), so nothing breaks — you just don't get the fast path.

## How it's consumed

`packages/werkmeister-core/src/jira-rest.ts` reads `JIRA_BASE_URL` / `JIRA_EMAIL` /
`JIRA_API_TOKEN` from the process env first, then from the `jira:` section of
`~/.werkmeister/config.yaml`.
When credentials are absent or a call fails, every caller degrades to the
original `claude -p` (Atlassian MCP) path — the token is an optimization, not
a requirement.

Endpoints used (API v2, which returns rich-text fields as plain wiki-markup
strings — v3 returns ADF JSON we'd have to walk):

- `GET /rest/api/3/myself` — verify only
- `GET /rest/api/2/issue/<KEY>?fields=…` — issue card, briefing, form prefill
- `GET /rest/api/2/search/jql?jql=key in (…)&fields=status` — batch status
  lookup (the old `/rest/api/2/search` endpoint is deprecated/removed; use
  `/search/jql`)
- `GET /rest/api/2/issue/createmeta/<PROJECT>/issuetypes`, `POST /rest/api/2/issue`
  — `issue create`
- `GET`/`POST /rest/api/2/issue/<KEY>/transitions`, `POST …/comment` — status
  moves and comments

## Renewal

Tokens expire (max 1 year). Symptom: Jira status pills / cards silently fall
back to the slow path, or `401` in the server log. Fix: repeat step 1, paste
the new token into `jira.api_token` in `~/.werkmeister/config.yaml`.
