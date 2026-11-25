"""Put the given issues at the top of the project's open issues, in the given order, then verify.

  python3 -I rank.py PROJ-25 PROJ-13 PROJ-38 ...
  python3 -I rank.py --tracker github --owner ORG --board N owner/repo#12 owner/repo#7 ...
Ranks one issue at a time (batch ranking and moves across an epic card misplace issues).
A rank call can return 204 without moving the issue, and the agile board endpoint can serve
a stale order, so every move is checked against the issue's own Rank field and retried.
On GitHub the order is the Projects (v2) board's item order; each move is checked by re-reading the board.
"""
import argparse, base64, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('keys', nargs='+')
ap.add_argument('--tracker', choices=('jira', 'github'), default='jira')
ap.add_argument('--owner', help='GitHub: the org that owns the Projects board')
ap.add_argument('--board', type=int, help='GitHub: the Projects (v2) number')
a = ap.parse_args()

def retry(k, do, placed):
    for t in range(4):
        if placed(): return
        do()
        time.sleep(1 + t)
    if not placed(): sys.exit(f'{k} did not move after 4 tries')

if a.tracker == 'github':
    if not (a.owner and a.board): ap.error('--tracker github needs --owner and --board')
    def gh(q, **v):
        args = ['gh', 'api', 'graphql', '-f', f'query={q}'] + [x for k, val in v.items() if val is not None
                                                             for x in ('-F' if isinstance(val, int) else '-f', f'{k}={val}')]
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode: sys.exit(f'gh api graphql failed: {r.stderr.strip()} (moving board items needs the project scope: gh auth refresh -s project)')
        return json.loads(r.stdout)['data']
    Q = ('query($owner:String!,$n:Int!,$after:String){organization(login:$owner){projectV2(number:$n){id items(first:100,after:$after){'
         'pageInfo{hasNextPage endCursor} nodes{id content{... on Issue{number repository{nameWithOwner}}}}}}}}')
    # shortcut: org-owned boards only, as report.py; add user(login:) when a user board is configured.
    def board():
        items, after = [], None
        while True:
            p = gh(Q, owner=a.owner, n=a.board, after=after)['organization']['projectV2']
            items += [(x['id'], f"{x['content']['repository']['nameWithOwner']}#{x['content']['number']}")
                      for x in p['items']['nodes'] if 'number' in (x['content'] or {})]
            if not p['items']['pageInfo']['hasNextPage']: return p['id'], items
            after = p['items']['pageInfo']['endCursor']
    pid, items = board()
    ids = {ref: i for i, ref in items}
    missing = [k for k in a.keys if k not in ids]
    if missing: sys.exit(f'not on board {a.board}: {", ".join(missing)}')
    order = lambda: [ref for _, ref in board()[1]]
    M = 'mutation($p:ID!,$i:ID!,$after:ID){updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i,afterId:$after}){clientMutationId}}'
    move = lambda k, prev=None: gh(M, p=pid, i=ids[k], after=ids[prev] if prev else None)  # no afterId = top of the board
    retry(a.keys[0], lambda: move(a.keys[0]), lambda: order()[0] == a.keys[0])
    for prev, k in zip(a.keys, a.keys[1:]):
        retry(k, lambda: move(k, prev), lambda: (o := order()).index(prev) < o.index(k))
    o = order()
    bad = [f'{x} before {y}' for x, y in zip(a.keys, a.keys[1:]) if not o.index(x) < o.index(y)]
    if bad or o[0] != a.keys[0]: sys.exit('order still differs: ' + ', '.join(bad or [f'{o[0]} is above {a.keys[0]}']))
    print(f'ok: {len(a.keys)} issues in order (checked by re-reading board {a.board})')
    sys.exit(0)

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
