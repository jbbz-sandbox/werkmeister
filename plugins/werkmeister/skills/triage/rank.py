"""Put the given issues at the top of the project's open issues, in the given order, then verify.

  python3 -I rank.py PROJ-25 PROJ-13 PROJ-38 ...
Ranks one issue at a time (batch ranking and moves across an epic card misplace issues).
A rank call can return 204 without moving the issue, and the agile board endpoint can serve
a stale order, so every move is checked against the issue's own Rank field and retried.
"""
import argparse, base64, json, os, re, sys, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('keys', nargs='+')
a = ap.parse_args()

cfg = open(os.path.expanduser('~/.werkmeister/config.yaml')).read().split('\njira:')[1]
g = lambda k: re.search(rf'^\s+{k}:\s*(\S+)', cfg, re.M).group(1).strip('"\'')
BASE = g('base_url')
H = {'Authorization': 'Basic ' + base64.b64encode(f"{g('email')}:{g('api_token')}".encode()).decode(),
     'Accept': 'application/json', 'Content-Type': 'application/json'}
def call(method, path, body=None):
    r = urllib.request.urlopen(urllib.request.Request(BASE + path, method=method, headers=H,
                               data=json.dumps(body).encode() if body else None), timeout=30).read()
    return json.loads(r) if r else None

RANK = next(f['id'] for f in call('GET', '/rest/api/3/field') if f['name'] == 'Rank')
rank = lambda k: call('GET', f'/rest/api/3/issue/{k}?fields={RANK}')['fields'][RANK]  # LexoRank: sorts as text

def top():
    q = urllib.parse.quote(f'project = {a.keys[0].split("-")[0]} AND statusCategory != Done ORDER BY Rank')
    return call('GET', f'/rest/api/3/search/jql?jql={q}&maxResults=1&fields=summary')['issues'][0]['key']

def move(k, body, placed):
    for t in range(4):
        if placed(): return
        try:
            call('PUT', '/rest/agile/1.0/issue/rank', body)
        except urllib.error.HTTPError as e:
            sys.exit(f'rank {k} failed ({e.code}): {e.read().decode()[:300]}')
        time.sleep(1 + t)
    if not placed(): sys.exit(f'{k} did not move after 4 tries: {json.dumps(body)}')

t = top()
if a.keys[0] != t:
    move(a.keys[0], {'issues': [a.keys[0]], 'rankBeforeIssue': t}, lambda: rank(a.keys[0]) < rank(t))
for prev, k in zip(a.keys, a.keys[1:]):
    move(k, {'issues': [k], 'rankAfterIssue': prev}, lambda: rank(prev) < rank(k))

r = [rank(k) for k in a.keys]
bad = [f'{x} before {y}' for x, y, rx, ry in zip(a.keys, a.keys[1:], r, r[1:]) if not rx < ry]
if bad or top() != a.keys[0]: sys.exit('order still differs: ' + ', '.join(bad or [f'{top()} is above {a.keys[0]}']))
print(f'ok: {len(a.keys)} issues in order (checked by Rank field)')
