# Jira REST setup (API token)

Setup log for direct Jira REST access from `apps/sandbox-dashboard` — replaces the
`claude -p` → Atlassian-MCP round-trips for data-only Jira reads (status pills,
issue cards, refine briefings). Written as a log so it can become an onboarding
doc/script; steps marked **[manual]** cannot be scripted, everything else can.

First performed: 2026-07-11. Verified working same day.

> **Automated:** `sandbox setup` now scaffolds `~/.sandbox/jira.env` (chmod
> 600) and live-verifies a filled-in token against `/rest/api/2/myself`;
> `sandbox setup --check` reports its state without touching the network.
> Only step 1 below (creating the token) remains manual. The step is
> optional — a missing/unfilled token reports ok-with-guidance, and only a
> filled token that Jira rejects fails setup.

## Steps

1. **[manual] Create an Atlassian API token**
   - Open <https://id.atlassian.com/manage-profile/security/api-tokens>
     (log in with your Atlassian account — the one you use for
     your Jira site, e.g. your-org.atlassian.net).
   - Click **Create API token** (the plain one, *not* "with scopes" — the
     unscoped token works with all REST endpoints we use).
   - Name: `sandbox-jira` (anything memorable). Expiry: max is 1 year — note
     the date; you'll repeat this step then.
   - Copy the token immediately (it is shown once).

2. **Create the credentials file** (scriptable):

   ```bash
   mkdir -p ~/.sandbox
   cat > ~/.sandbox/jira.env << 'EOF'
   JIRA_BASE_URL=https://your-org.atlassian.net
   JIRA_EMAIL=<your-atlassian-login-email>
   JIRA_API_TOKEN=<paste-token-here>
   EOF
   chmod 600 ~/.sandbox/jira.env
   ```

   `JIRA_EMAIL` is the address on your Atlassian *account*. Email aliases may
   authenticate too, but use the canonical one if in doubt — check your
   avatar menu in Jira.

3. **Verify** (scriptable — this is the health check):

   ```bash
   source ~/.sandbox/jira.env && curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
     "$JIRA_BASE_URL/rest/api/2/myself" | jq '{displayName, emailAddress}'
   ```

   Your display name back = working. A `401` mentioning policy = the org has
   disabled API tokens via SSO policy; the sandbox-dashboard server then falls
   back to its previous path (Jira via the local `claude` CLI + Atlassian
   MCP), so nothing breaks — you just don't get the fast path.

## How it's consumed

`packages/sandbox-core/src/jira-rest.ts` reads `JIRA_BASE_URL` / `JIRA_EMAIL` /
`JIRA_API_TOKEN` from the process env first, then from `~/.sandbox/jira.env`.
When credentials are absent or a call fails, every caller degrades to the
original `claude -p` (Atlassian MCP) path — the token is an optimization, not
a requirement.

Endpoints used (API v2, which returns rich-text fields as plain wiki-markup
strings — v3 returns ADF JSON we'd have to walk):

- `GET /rest/api/2/myself` — verify only
- `GET /rest/api/2/issue/<KEY>?fields=…` — issue card, briefing, form prefill
- `GET /rest/api/2/search/jql?jql=key in (…)&fields=status` — batch status
  lookup (the old `/rest/api/2/search` endpoint is deprecated/removed; use
  `/search/jql`)

## Renewal

Tokens expire (max 1 year). Symptom: Jira status pills / cards silently fall
back to the slow path, or `401` in the server log. Fix: repeat step 1, paste
the new token into `~/.sandbox/jira.env`.
