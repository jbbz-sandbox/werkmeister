"""Jira REST credentials for the triage scripts, in the CLI's order (SW-994, SW-945).

JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the environment win. Otherwise base_url and email
come from the jira: block of config.yaml and the token from JIRA_API_TOKEN in secrets.env beside it
(a jira.api_token left in config.yaml is the fallback); WERKMEISTER_CONFIG_FILE relocates both.
"""
import os, re, sys


def _read(path):
    try:
        with open(path) as fh:
            return fh.read()
    except OSError:
        return ''


def jira_creds():
    """(base_url, email, token), or exit naming both places to set them."""
    env = [os.environ.get(k, '').strip() for k in ('JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN')]
    if all(env):
        return env[0].rstrip('/'), env[1], env[2]
    cfg = os.path.expanduser(os.environ.get('WERKMEISTER_CONFIG_FILE') or '~/.werkmeister/config.yaml')
    secrets = os.path.join(os.path.dirname(cfg), 'secrets.env')
    m = re.search(r'^jira:[ \t]*\n((?:[ \t]+.*(?:\n|$)|[ \t]*\n)*)', _read(cfg), re.M)
    block = m.group(1) if m else ''

    def g(k):
        v = re.search(rf'^\s+{k}:\s*(\S+)', block, re.M)
        return v.group(1).strip('"\'') if v else ''

    tok = re.findall(r'^\s*JIRA_API_TOKEN=(.*)$', _read(secrets), re.M)  # the last line wins, as the CLI reads it
    base, email, token = g('base_url'), g('email'), (tok[-1].strip() if tok else '') or g('api_token')
    if not (base and email and token):
        sys.exit(f'no Jira credentials: export JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN, or set base_url '
                 f'and email under jira: in {cfg} and JIRA_API_TOKEN in {secrets}')
    return base.rstrip('/'), email, token

