"""Apply an approved Jira triage plan in one run (SKILL.md step 5): the writes in parallel, then rank.py.

  python3 -I apply.py plan.json [--dry-run]
  python3 -I apply.py --self-test

plan.json (every key optional):
  {"project": "SW",                                      # needed only with new_components
   "date": "YYYY-MM-DD",                                  # the group comments' triage date; default today
   "priorities": {"SW-1": "High"},
   "new_components": {"<name>": "<what it covers>"},       # made before any ticket is given one
   "components": {"SW-1": "<name>"},
   "links": [{"type": "Blocks", "from": "SW-1", "to": "SW-2"}],   # reads "SW-1 blocks SW-2"; Duplicate: "from duplicates to"
   "groups": {"SW-1": ["SW-2", "SW-3"]},                   # lead: its FULL member list; closed members are dropped
   "close": [{"key": "SW-4", "duplicate_of": "SW-5", "comment": "why"}],
   "order": ["SW-1", "SW-2"]}                              # the whole open order, passed to rank.py
"""
import argparse, base64, concurrent.futures as cf, datetime as dt, json, os, re, subprocess, sys, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('plan', nargs='?')
ap.add_argument('--dry-run', action='store_true', help='print the writes, send nothing')
ap.add_argument('--self-test', action='store_true')
a = ap.parse_args()

def adf(parts):  # parts: str or ('card', KEY)
    return {'type': 'doc', 'version': 1, 'content': [{'type': 'paragraph', 'content': [
        {'type': 'inlineCard', 'attrs': {'url': f'{BASE}/browse/{p[1]}'}} if isinstance(p, tuple) else {'type': 'text', 'text': p} for p in parts]}]}

def linked(info, a_key, b_key, typ):
    return any(l['type']['name'] == typ and (l.get('inwardIssue') or l.get('outwardIssue'))['key'] == b_key for l in info.get(a_key, {}).get('links', []))

def writes(plan, info, done_transition, date):
    """(first, rest, notes): first = component creates, rest = every other write; both lists of (method, path, body).
    info: key -> {'done': bool, 'links': [...]}; done_transition: key -> transition id."""
    first = [('POST', '/rest/api/3/component', {'project': plan['project'], 'name': n, 'description': d})
             for n, d in plan.get('new_components', {}).items()]
    rest, notes = [], []
    fields = {}  # one PUT per issue for its priority and component
    for k, p in plan.get('priorities', {}).items(): fields.setdefault(k, {})['priority'] = {'name': p}
    for k, c in plan.get('components', {}).items(): fields.setdefault(k, {})['components'] = [{'name': c}]
    rest += [('PUT', f'/rest/api/3/issue/{k}', {'fields': v}) for k, v in fields.items()]
    link = lambda typ, frm, to: ('POST', '/rest/api/3/issueLink', {'type': {'name': typ}, 'inwardIssue': {'key': frm}, 'outwardIssue': {'key': to}})
    rest += [link(l['type'], l['from'], l['to']) for l in plan.get('links', []) if not linked(info, l['from'], l['to'], l['type'])]
    for lead, members in plan.get('groups', {}).items():
        shipped = [m for m in members if info.get(m, {}).get('done')]
        if shipped: notes.append(f'{lead}: dropped closed members {", ".join(shipped)}')
        members = [m for m in dict.fromkeys(members) if m not in shipped and m != lead]
        if not members: notes.append(f'{lead}: no open members left, no group comment'); continue
        parts = [f'Grouped PR (triage {date}): ', ('card', lead), ' leads one workspace and one PR for ']
        for i, m in enumerate(members): parts += [('card', m), ', ' if i < len(members) - 1 else '. ']
        parts.append('One commit per ticket so each can be reverted alone. Close each member when the PR ships.')
        rest.append(('POST', f'/rest/api/3/issue/{lead}/comment', {'body': adf(parts)}))
        rest += [link('Relates', m, lead) for m in members if not linked(info, m, lead, 'Relates')]
    for c in plan.get('close', []):
        k = c['key']
        if c.get('duplicate_of') and not linked(info, k, c['duplicate_of'], 'Duplicate'):
            rest.append(link('Duplicate', k, c['duplicate_of']))
        if c.get('comment'):
            rest.append(('POST', f'/rest/api/3/issue/{k}/comment', {'body': adf([c['comment']])}))
        if k in done_transition: rest.append(('POST', f'/rest/api/3/issue/{k}/transitions', {'transition': {'id': done_transition[k]}}))
        else: notes.append(f'{k}: no transition to a done status, left open')
    return first, rest, notes

if a.self_test:
    BASE = 'https://x'
    info = {'SW-3': {'done': True, 'links': []},
            'SW-2': {'done': False, 'links': [{'type': {'name': 'Relates'}, 'outwardIssue': {'key': 'SW-1'}}]},
            'SW-5': {'done': False, 'links': []}}
    plan = {'project': 'SW', 'priorities': {'SW-1': 'High'}, 'components': {'SW-2': 'gate'}, 'new_components': {'gate': 'pr gate'},
            'groups': {'SW-1': ['SW-2', 'SW-3', 'SW-4', 'SW-2']}, 'close': [{'key': 'SW-5', 'duplicate_of': 'SW-1', 'comment': 'dup'}],
            'links': [{'type': 'Relates', 'from': 'SW-2', 'to': 'SW-1'}]}
    first, rest, notes = writes(plan, info, {'SW-5': '41'}, '2026-01-01')
    assert first == [('POST', '/rest/api/3/component', {'project': 'SW', 'name': 'gate', 'description': 'pr gate'})], first
    paths = [(m, p) for m, p, _ in rest]
    body = json.dumps([b for m, p, b in rest if p == '/rest/api/3/issue/SW-1/comment'])
    assert 'SW-2' in body and 'SW-4' in body and 'SW-3' not in body and body.count('browse/SW-2') == 1, body  # closed and repeated members dropped
    assert 'dropped closed members SW-3' in notes[0], notes
    rl = [b for m, p, b in rest if p == '/rest/api/3/issueLink']
    assert {'type': {'name': 'Relates'}, 'inwardIssue': {'key': 'SW-4'}, 'outwardIssue': {'key': 'SW-1'}} in rl
    assert not any(b['inwardIssue']['key'] == 'SW-2' and b['type']['name'] == 'Relates' for b in rl), rl  # already linked
    assert {'type': {'name': 'Duplicate'}, 'inwardIssue': {'key': 'SW-5'}, 'outwardIssue': {'key': 'SW-1'}} in rl  # SW-5 duplicates SW-1
    assert ('POST', '/rest/api/3/issue/SW-5/transitions') in paths and ('PUT', '/rest/api/3/issue/SW-1') in paths
    _, rest, _ = writes({'priorities': {'SW-1': 'Low'}, 'components': {'SW-1': 'ui'}}, {}, {}, 'd')
    assert rest == [('PUT', '/rest/api/3/issue/SW-1', {'fields': {'priority': {'name': 'Low'}, 'components': [{'name': 'ui'}]}})], rest
    _, _, notes = writes({'close': [{'key': 'SW-9'}]}, {}, {}, 'd')
    assert 'left open' in notes[0]
    print('self-test ok')
    sys.exit(0)

if not a.plan: ap.error('give the plan file')
plan = json.load(open(a.plan))
cfg = open(os.path.expanduser('~/.werkmeister/config.yaml')).read().split('\njira:')[1]
g = lambda k: re.search(rf'^\s+{k}:\s*(\S+)', cfg, re.M).group(1).strip('"\'')
BASE = g('base_url')
H = {'Authorization': 'Basic ' + base64.b64encode(f"{g('email')}:{g('api_token')}".encode()).decode(),
     'Accept': 'application/json', 'Content-Type': 'application/json'}

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, headers=H, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    return json.loads(raw) if raw else None

pool = cf.ThreadPoolExecutor(8)
keys = sorted({k for g_ in plan.get('groups', {}).items() for k in [g_[0], *g_[1]]}
              | {l['from'] for l in plan.get('links', [])} | {c['key'] for c in plan.get('close', [])})
info = {}
def search(chunk):
    q = urllib.parse.quote(f"key in ({','.join(chunk)})")
    return call('GET', f'/rest/api/3/search/jql?jql={q}&fields=status,issuelinks&maxResults=100')['issues']
for issues in pool.map(search, [keys[i:i + 100] for i in range(0, len(keys), 100)]):
    for i in issues:
        info[i['key']] = {'done': i['fields']['status']['statusCategory']['key'] == 'done', 'links': i['fields']['issuelinks']}
def done_id(k):
    ts = call('GET', f'/rest/api/3/issue/{k}/transitions')['transitions']
    t = next((t for t in ts if t['name'] == 'Done'), None) or next((t for t in ts if t['to']['statusCategory']['key'] == 'done'), None)
    return k, t and t['id']
done = {k: t for k, t in pool.map(done_id, [c['key'] for c in plan.get('close', [])]) if t}

first, rest, notes = writes(plan, info, done, plan.get('date') or f'{dt.date.today()}')
failed = []
def send(w):
    if a.dry_run: return print(w[0], w[1], json.dumps(w[2])[:200])
    try: call(*w)
    except urllib.error.HTTPError as e: failed.append(f'{w[0]} {w[1]}: {e.code} {e.read()[:300]!r}')
list(pool.map(send, first))  # components exist before any ticket is given one
list(pool.map(send, rest))
print(f'{len(first) + len(rest)} writes' + (' (dry run)' if a.dry_run else f', {len(failed)} failed'))
for n in notes + failed: print('-', n)
if plan.get('order') and not a.dry_run:
    r = subprocess.run([sys.executable, '-I', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rank.py'), *plan['order']])
    if r.returncode: failed.append('rank.py failed')
sys.exit(1 if failed else 0)
