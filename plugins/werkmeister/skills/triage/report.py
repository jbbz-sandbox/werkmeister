"""Read-only backlog health report for a Jira project. Prints Markdown.

  python3 -I report.py --project KEY --board ID [--epic-steps] [--out FILE] [--notify]
  python3 -I report.py --project KEY --mark   # record that triage was just done (new = created after this)
  python3 -I report.py --self-test            # check the placement rules on fixtures, no Jira
"""
import argparse, base64, datetime as dt, json, os, re, subprocess, sys, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--project')
ap.add_argument('--board', type=int)
ap.add_argument('--epic-steps', action='store_true',
                help='check the step rule: each child of an epic sits just above the tickets it "relates to"')
ap.add_argument('--out')
ap.add_argument('--notify', action='store_true', help='macOS notification with the counts')
ap.add_argument('--mark', action='store_true')
ap.add_argument('--stale-days', type=int, default=30)
ap.add_argument('--review-days', type=int, default=7)
ap.add_argument('--self-test', action='store_true')
a = ap.parse_args()
if not a.self_test and not (a.project and (a.mark or a.board)):
    ap.error('--project and --board are required (the skill reads them from projects: in ~/.werkmeister/config.yaml)')

PRI = {'Highest': 0, 'High': 1, 'Medium': 2, 'Low': 3, 'Lowest': 4}
WIP = {'in review': 0, 'in progress': 1}

def placement(keys, f, epic_steps):
    """SKILL.md rules the "blocks" check can't see: work in progress on top, no priority rising
    down the order, epics last; with epic_steps, each epic step directly above the tickets it relates to
    (a project rule, opt-in so a project without step epics isn't flagged for every epic child)."""
    epic = lambda k: f[k]['issuetype']['name'] == 'Epic'
    cards = [k for k in keys if not epic(k)]
    pos = {k: n for n, k in enumerate(cards)}
    wip = lambda k: WIP.get(f[k]['status']['name'].lower(), 2)
    pri = lambda k: PRI.get(f[k]['priority']['name'], 2)
    out = []
    for k in cards:
        above = [j for j in cards[:pos[k]] if wip(j) > wip(k)]
        if above: out.append(f"- {k} ({f[k]['status']['name']}) is ranked below {above[0]} ({f[above[0]]['status']['name']}): work in progress goes first")
    steps = [k for k in cards if epic_steps and (f[k].get('parent') or {}).get('fields', {}).get('issuetype', {}).get('name') == 'Epic']
    rel = lambda k: {(l.get('inwardIssue') or l.get('outwardIssue'))['key'] for l in f[k]['issuelinks'] if l['type']['name'] == 'Relates'}
    for t in cards:
        if t in steps or wip(t) < 2: continue  # work in progress outranks the step rule
        mine = [s for s in steps if s in rel(t)]
        if not mine: continue
        s = mine[0]  # steps is in rank order, so this is the earliest step it relates to
        nxt = next((x for x in steps if pos[x] > pos[s]), None)
        if pos[t] < pos[s]: out.append(f'- {t} is ranked above {s}, the step that should close it')
        elif nxt and pos[t] > pos[nxt]: out.append(f'- {t} is ranked below the next step {nxt}; it belongs just below {s}, the step that should close it')
    for k in cards:
        higher = [j for j in cards[pos[k] + 1:] if pri(j) < pri(k) and wip(j) <= wip(k)]  # work in progress outranks priority (rule 1)
        if higher: out.append(f"- {k} ({f[k]['priority']['name']}) is ranked above {higher[0]} ({f[higher[0]]['priority']['name']}): park it lower or raise its priority")
    last_card = max((keys.index(k) for k in cards), default=-1)
    out += [f'- epic {k} is ranked above cards; epics go last' for k in keys if epic(k) and keys.index(k) < last_card]
    return out

if a.self_test:
    def mk(status='To Do', pri='Medium', typ='Task', step=False, rel=()):
        return {'status': {'name': status}, 'priority': {'name': pri}, 'issuetype': {'name': typ},
                'parent': {'fields': {'issuetype': {'name': 'Epic'}}} if step else None,
                'issuelinks': [{'type': {'name': 'Relates'}, 'outwardIssue': {'key': r}} for r in rel]}
    ok = {'A': mk('In Review'), 'W': mk('In Progress'), 'H': mk(pri='Highest'), 'S1': mk(step=True), 'T1': mk(rel=['S1']), 'S2': mk(step=True), 'T2': mk(rel=['S2']),
          'P': mk(pri='Low'), 'E': mk(typ='Epic')}
    assert placement(list(ok), ok, True) == [], placement(list(ok), ok, True)
    bad = {'T1': mk(rel=['S1']), 'S1': mk(step=True), 'S2': mk(step=True), 'P': mk(pri='Low'), 'E': mk(typ='Epic'),
           'T2': mk(rel=['S1']), 'A': mk('In Review'), 'Q': mk()}
    got = '\n'.join(placement(list(bad), bad, True))
    generic = ('A (In Review) is ranked below T1', 'P (Low) is ranked above T2', 'epic E is ranked above cards')
    steps = ('T1 is ranked above S1', 'T2 is ranked below the next step S2')
    for want in generic + steps:
        assert want in got, f'missing {want!r} in:\n{got}'
    got = '\n'.join(placement(list(bad), bad, False))  # a project with no step rule: generic findings only
    for want in generic:
        assert want in got, f'missing {want!r} in:\n{got}'
    for unwanted in steps:
        assert unwanted not in got, f'step rule ran without --epic-steps: {unwanted!r} in:\n{got}'
    print('self-test ok')
    sys.exit(0)

MARK = os.path.expanduser(f'~/.cache/backlog-triage/{a.project}-last-triage')
now = dt.datetime.now(dt.timezone.utc)
if a.mark:
    os.makedirs(os.path.dirname(MARK), exist_ok=True)
    open(MARK, 'w').write(now.isoformat())
    sys.exit(f'triage marked done at {now:%Y-%m-%d %H:%M} UTC')

cfg = open(os.path.expanduser('~/.werkmeister/config.yaml')).read().split('\njira:')[1]
g = lambda k: re.search(rf'^\s+{k}:\s*(\S+)', cfg, re.M).group(1).strip('"\'')
BASE = g('base_url')
H = {'Authorization': 'Basic ' + base64.b64encode(f"{g('email')}:{g('api_token')}".encode()).decode(), 'Accept': 'application/json'}
get = lambda p: json.load(urllib.request.urlopen(urllib.request.Request(BASE + p, headers=H), timeout=30))
when = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00'))  # keeps Jira's -0700 offset

# Open issues in board order (board order = rank)
F = 'summary,status,priority,issuetype,created,updated,statuscategorychangedate,issuelinks,description,parent,components'
jql = urllib.parse.quote('statusCategory != Done')
issues, start = [], 0
while True:
    page = get(f'/rest/agile/1.0/board/{a.board}/issue?jql={jql}&fields={F}&maxResults=100&startAt={start}')
    issues += page['issues']
    start += len(page['issues'])
    if start >= page['total'] or not page['issues']: break
rank = {i['key']: n for n, i in enumerate(issues)}
f = {i['key']: i['fields'] for i in issues}
cat = lambda k: f[k]['status']['statusCategory']['key']  # new / indeterminate / done
comp = lambda k: ', '.join(c['name'] for c in f[k].get('components') or [])  # the grouping key (SKILL.md § Components)
row = lambda k: f"| [{k}]({BASE}/browse/{k}) | {f[k]['issuetype']['name']} | {f[k]['priority']['name']} | {f[k]['status']['name']} | {comp(k)} | {f[k]['summary'][:80]} |"
HEAD = '| Key | Type | Priority | Status | Component | Summary |\n|---|---|---|---|---|---|'
blockers = {k: [l['inwardIssue']['key'] for l in x['issuelinks'] if l['type']['name'] == 'Blocks' and 'inwardIssue' in l] for k, x in f.items()}

since = when(open(MARK).read()) if os.path.exists(MARK) else now - dt.timedelta(days=7)
new = [k for k in rank if when(f[k]['created']) > since and f[k]['issuetype']['name'] != 'Epic']

order = []  # blocked item ranked above an open blocker
for k in rank:
    for b in blockers[k]:
        if b not in rank: continue  # blocker is done
        if rank[k] < rank[b]: order.append(f'- {k} is ranked above {b}, which blocks it')
order += placement(list(rank), f, a.epic_steps)

def card_keys(node):  # issue keys after a "Depends on" phrase (the agile API returns wiki text, v3 returns ADF)
    t = node if isinstance(node, str) else ' '.join(x.get('text') or (x.get('attrs') or {}).get('url', '') for x in _walk(node))
    return {m for s in re.findall(r'Depends on:?(.{0,200})', t) for m in re.findall(rf'\b{a.project}-\d+\b', s)}
def _walk(n):
    if isinstance(n, dict):
        yield n
        for c in n.get('content', []): yield from _walk(c)
unlinked = [f'- {k} says it depends on {d}, but there is no "blocks" link'
            for k in rank for d in sorted(card_keys(f[k]['description'] or {})) if d != k and d in rank and d not in blockers[k]]

review = [k for k in rank if f[k]['status']['name'].lower() == 'in review'
          and now - when(f[k]['statuscategorychangedate']) > dt.timedelta(days=a.review_days)]
stale = [k for k in rank if cat(k) == 'new' and now - when(f[k]['updated']) > dt.timedelta(days=a.stale_days)]

sec = lambda title, ks: f"\n## {title} ({len(ks)})\n\n" + (HEAD + '\n' + '\n'.join(map(row, ks)) if ks else 'None.') + '\n'
lst = lambda title, xs: f"\n## {title} ({len(xs)})\n\n" + ('\n'.join(xs) if xs else 'None.') + '\n'
md = (f"# {a.project} backlog check, {now:%Y-%m-%d}\n\n{len(rank)} open issues. "
      f"Last triage: {since:%Y-%m-%d}.\n"
      + sec('New since last triage: place on the board', new)
      + sec('No component: assign one', [k for k in rank if not comp(k) and f[k]['issuetype']['name'] != 'Epic'])
      + lst('Order problems', order)
      + lst('Dependencies written in the description but not linked', unlinked)
      + sec(f'In Review for over {a.review_days} days', review)
      + sec(f'To Do with no update for {a.stale_days}+ days', stale))
if a.out:
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    open(a.out, 'w').write(md)
print(md)
if a.notify:
    n = len(new) + len(order) + len(unlinked) + len(review) + len(stale)
    msg = f'{len(new)} new, {len(order)} order, {len(unlinked)} unlinked, {len(review)} review, {len(stale)} stale'
    subprocess.run(['osascript', '-e', f'display notification "{msg}" with title "{a.project} backlog: {n} to look at"'])
