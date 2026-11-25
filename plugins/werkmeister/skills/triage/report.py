"""Read-only backlog health report for a Jira or GitHub project. Prints Markdown.

  python3 -I report.py --project KEY --board ID [--epic-steps] [--out FILE] [--notify]
  python3 -I report.py --tracker github --owner ORG --board N --project NAME --components a,b [--out FILE] [--notify]
  python3 -I report.py --project KEY --mark   # record that triage was just done (new = created after this)
  python3 -I report.py --self-test            # check the placement rules on fixtures, no Jira or GitHub
"""
import argparse, base64, datetime as dt, json, os, re, subprocess, sys, urllib.parse, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--tracker', choices=('jira', 'github'), default='jira')
ap.add_argument('--project', help='Jira: the project key. GitHub: the werkmeister project name (names the last-triage mark)')
ap.add_argument('--board', type=int, help='Jira: the board id. GitHub: the Projects (v2) number')
ap.add_argument('--owner', help='GitHub: the org that owns the Projects board (tracker.org)')
ap.add_argument('--components', default='', help='GitHub: repo.components names, comma-separated; a label with one of these names is the component')
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
if a.tracker == 'github' and not (a.self_test or a.mark or a.owner):
    ap.error('--tracker github needs --owner (the project\'s tracker.org)')

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

def _walk(n):
    if isinstance(n, dict):
        yield n
        for c in n.get('content', []): yield from _walk(c)
def text(node):  # the agile API returns wiki text, v3 returns ADF, GitHub a string
    return node if isinstance(node, str) else ' '.join(x.get('text') or (x.get('attrs') or {}).get('url', '') for x in _walk(node))

# shortcut: fenced blocks are skipped, so a path only inside a pasted log or snippet is missed; scan them if tickets lean on that.
FENCED = re.compile(r'```.*?```|\{(code|noformat)[^}]*\}.*?\{\1\}', re.S)
SPAN = re.compile(r'\{\{(.+?)\}\}|`([^`\n]+)`')
BARE_PATH = re.compile(r'(?<![\w/.-])(?:[\w.-]+/)+[\w.-]+\.[A-Za-z]\w*(?::\d+)?')

def code_named(desc):
    """The code a ticket names (SKILL.md step 2 maps it): Jira wiki {{…}}, markdown `…`, ADF code marks, and bare paths in text descriptions.
    Command spans (`pr open`) stay in: some duplicates share only those (SW-1206 / SW-1197)."""
    if isinstance(desc, dict):
        found = [n['text'] for n in _walk(desc) if n.get('text') and any(m.get('type') == 'code' for m in n.get('marks', []))]
    else:
        s = re.sub(r'https?://\S+', ' ', FENCED.sub(' ', desc or ''))
        s = re.sub(r'\\([^\w\s]|_)', r'\1', s)  # the agile API's wiki text escapes - _ { } as \- \_ \{ \}
        found = [a or b for a, b in SPAN.findall(s)] + BARE_PATH.findall(SPAN.sub(' ', s))
    return list(dict.fromkeys(x.strip() for x in found if x.strip()))

code_lines = lambda keys, f, url: [f"- [{k}]({url(k)}): {', '.join(c)}" for k in keys if (c := code_named(f[k].get('description')))]

def checks(keys, f, epic_steps, ref_re):
    """Order problems (blocked above its open blocker, plus placement()) and "Depends on" refs with no "blocks" link."""
    rank = {k: n for n, k in enumerate(keys)}
    blockers = {k: [l['inwardIssue']['key'] for l in f[k]['issuelinks'] if l['type']['name'] == 'Blocks' and 'inwardIssue' in l] for k in keys}
    order = [f'- {k} is ranked above {b}, which blocks it' for k in keys for b in blockers[k] if b in rank and rank[k] < rank[b]]  # a blocker not in rank is done
    order += placement(keys, f, epic_steps)
    unlinked = []
    for k in keys:
        repo = k.split('#')[0]  # GitHub: a bare #N is in the issue's own repo
        deps = {repo + m if m.startswith('#') else m for s in re.findall(r'Depends on:?(.{0,200})', text(f[k]['description'] or {})) for m in re.findall(ref_re, s)}
        unlinked += [f'- {k} says it depends on {d}, but there is no "blocks" link' for d in sorted(deps) if d != k and d in rank and d not in blockers[k]]
    return order, unlinked

no_component = lambda keys, f: [k for k in keys if not f[k].get('components') and f[k]['issuetype']['name'] != 'Epic']

GH_REF = r'(?:[\w.-]+/[\w.-]+)?#\d+'
def gh_fields(nodes, components):
    """Projects (v2) items in board order, as the Jira fields placement() and checks() read. Priority and
    work-in-progress status are labels (`priority:high`, `status: in review`: what werkmeister's status moves write)."""
    f = {}
    for node in nodes:
        i = node.get('content') or {}
        if 'number' not in i or i['state'] != 'OPEN': continue  # a PR or draft (no Issue fields), or closed
        labels = [l['name'] for l in i['labels']['nodes']]
        tag = lambda p: next((l[len(p):].strip() for l in labels if l.lower().startswith(p)), None)
        status, pri = tag('status:'), tag('priority:')
        ref = lambda x: f"{x['repository']['nameWithOwner']}#{x['number']}"
        f[ref(i)] = {
            'summary': i['title'], 'url': i['url'], 'description': i['body'],
            'status': {'name': status.title() if status else 'Open',
                       'statusCategory': {'key': 'indeterminate' if status and status.lower() in WIP else 'new'}},
            'priority': {'name': pri.title() if pri else 'Medium'},
            'issuetype': {'name': 'Epic' if i['subIssues']['totalCount'] else (i.get('issueType') or {}).get('name') or 'Issue'},
            'parent': None,  # the --epic-steps rule reads "relates to" links, which GitHub doesn't have
            'issuelinks': [{'type': {'name': 'Blocks'}, 'inwardIssue': {'key': ref(b)}} for b in i['blockedBy']['nodes']],
            'components': [{'name': l} for l in labels if l in components],
            'created': i['createdAt'], 'updated': i['updatedAt'],
            # shortcut: updatedAt stands in for the status-change time; read the label's timeline event if In Review ages mislead.
            'statuscategorychangedate': i['updatedAt'],
        }
    return f

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

    # GitHub: a canned `gh api graphql` page in board order, through the same checks
    def item(n, labels=(), blocked=(), subs=0, state='OPEN', body=''):
        r = {'nameWithOwner': 'o/r'}
        return {'content': {'number': n, 'url': f'https://github.com/o/r/issues/{n}', 'title': f't{n}', 'state': state, 'body': body,
                            'createdAt': '2026-11-01T00:00:00Z', 'updatedAt': '2026-11-02T00:00:00Z', 'repository': r, 'issueType': {'name': 'Task'},
                            'labels': {'nodes': [{'name': l} for l in labels]}, 'subIssues': {'totalCount': subs},
                            'blockedBy': {'nodes': [{'number': b, 'repository': r} for b in blocked]}}}
    page = {'data': {'organization': {'projectV2': {'items': {'pageInfo': {'hasNextPage': False}, 'nodes': [
        item(1, ['gate'], blocked=[2]), item(2, ['gate']), item(3, ['priority:low', 'gate']), item(4, ['gate'], body='Depends on #2'),
        item(5, ['status: in review', 'gate']), item(6, subs=2), item(7), {'content': {}}, item(9, ['gate'], state='CLOSED')]}}}}}
    gf = gh_fields(page['data']['organization']['projectV2']['items']['nodes'], {'gate'})
    assert list(gf) == [f'o/r#{n}' for n in (1, 2, 3, 4, 5, 6, 7)], list(gf)  # the PR item and the closed issue are dropped
    assert gf['o/r#3']['components'] == [{'name': 'gate'}] and gf['o/r#5']['status']['statusCategory']['key'] == 'indeterminate', gf
    order, unlinked = checks(list(gf), gf, False, GH_REF)
    got = '\n'.join(order + unlinked)
    for want in ('o/r#1 is ranked above o/r#2, which blocks it', 'o/r#5 (In Review) is ranked below o/r#1',
                 'o/r#3 (Low) is ranked above o/r#4', 'epic o/r#6 is ranked above cards',
                 'o/r#4 says it depends on o/r#2, but there is no "blocks" link'):
        assert want in got, f'missing {want!r} in:\n{got}'
    assert no_component(list(gf), gf) == ['o/r#7'], no_component(list(gf), gf)

    # code named: Jira wiki, GitHub markdown, ADF, and a ticket with none
    wiki = 'Seeds with {{seedDashboardHome}} from {{apps/cli/src/commands/serve.ts:57}}, again {{seedDashboardHome}}.'
    assert code_named(wiki) == ['seedDashboardHome', 'apps/cli/src/commands/serve.ts:57'], code_named(wiki)
    escaped = r'{{serve \-\-dashboard}} calls {{signal\_from}} in stages/01\_scope/output/scope.md'  # as the agile API sends it
    assert code_named(escaped) == ['serve --dashboard', 'signal_from', 'stages/01_scope/output/scope.md'], code_named(escaped)
    md = ('`pr open` reruns packages/x/y.ts and apps/x/schema.graphql; see https://example.com/a/b.md\n'
          '```\nlog at packages/z/hidden.ts\n```\n{code}packages/z/also.ts{code}')
    assert code_named(md) == ['pr open', 'packages/x/y.ts', 'apps/x/schema.graphql'], code_named(md)
    adf = {'type': 'doc', 'content': [{'type': 'paragraph', 'content': [
        {'type': 'text', 'text': 'calls '}, {'type': 'text', 'text': 'signalFrom', 'marks': [{'type': 'code'}]}]}]}
    assert code_named(adf) == ['signalFrom'], code_named(adf)
    assert code_named('Make a scratch Projects board by hand, 1/2.5 of it.') == [] and code_named(None) == []
    named = {'K-1': {'description': wiki}, 'K-2': {'description': 'no code here'}}
    assert code_lines(['K-1', 'K-2'], named, lambda k: k) == ['- [K-1](K-1): seedDashboardHome, apps/cli/src/commands/serve.ts:57']
    print('self-test ok')
    sys.exit(0)

MARK = os.path.expanduser(f'~/.cache/backlog-triage/{a.project}-last-triage')
now = dt.datetime.now(dt.timezone.utc)
if a.mark:
    os.makedirs(os.path.dirname(MARK), exist_ok=True)
    open(MARK, 'w').write(now.isoformat())
    sys.exit(f'triage marked done at {now:%Y-%m-%d %H:%M} UTC')

when = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00'))  # keeps Jira's -0700 offset

if a.tracker == 'github':
    Q = ('query($owner:String!,$n:Int!,$after:String){organization(login:$owner){projectV2(number:$n){items(first:100,after:$after){'
         'pageInfo{hasNextPage endCursor} nodes{content{... on Issue{number url title state body createdAt updatedAt '
         'repository{nameWithOwner} issueType{name} labels(first:50){nodes{name}} subIssues(first:1){totalCount} '
         'blockedBy(first:50){nodes{number repository{nameWithOwner}}}}}}}}}}')
    # shortcut: org-owned boards only (projects: documents board.id as a Projects number owned by org); add user(login:) when a user board is configured.
    nodes, after = [], None
    while True:
        r = subprocess.run(['gh', 'api', 'graphql', '-f', f'query={Q}', '-f', f'owner={a.owner}', '-F', f'n={a.board}']
                           + (['-f', f'after={after}'] if after else []), capture_output=True, text=True)
        if r.returncode: sys.exit(f'gh api graphql failed: {r.stderr.strip()} (a Projects board needs the read:project scope: gh auth refresh -s read:project)')
        items = json.loads(r.stdout)['data']['organization']['projectV2']['items']
        nodes += items['nodes']
        if not items['pageInfo']['hasNextPage']: break
        after = items['pageInfo']['endCursor']
    f = gh_fields(nodes, {c.strip() for c in a.components.split(',') if c.strip()})  # board order = rank
    ref_re = GH_REF
else:
    cfg = open(os.path.expanduser('~/.werkmeister/config.yaml')).read().split('\njira:')[1]
    g = lambda k: re.search(rf'^\s+{k}:\s*(\S+)', cfg, re.M).group(1).strip('"\'')
    BASE = g('base_url')
    H = {'Authorization': 'Basic ' + base64.b64encode(f"{g('email')}:{g('api_token')}".encode()).decode(), 'Accept': 'application/json'}
    get = lambda p: json.load(urllib.request.urlopen(urllib.request.Request(BASE + p, headers=H), timeout=30))

    # Open issues in board order (board order = rank)
    F = 'summary,status,priority,issuetype,created,updated,statuscategorychangedate,issuelinks,description,parent,components'
    jql = urllib.parse.quote('statusCategory != Done')
    issues, start = [], 0
    while True:
        page = get(f'/rest/agile/1.0/board/{a.board}/issue?jql={jql}&fields={F}&maxResults=100&startAt={start}')
        issues += page['issues']
        start += len(page['issues'])
        if start >= page['total'] or not page['issues']: break
    f = {i['key']: i['fields'] for i in issues}
    ref_re = rf'\b{a.project}-\d+\b'
rank = {k: n for n, k in enumerate(f)}
cat = lambda k: f[k]['status']['statusCategory']['key']  # new / indeterminate / done
comp = lambda k: ', '.join(c['name'] for c in f[k].get('components') or [])  # the grouping key (SKILL.md § Components)
link = lambda k: f[k].get('url') or f'{BASE}/browse/{k}'
row = lambda k: f"| [{k}]({link(k)}) | {f[k]['issuetype']['name']} | {f[k]['priority']['name']} | {f[k]['status']['name']} | {comp(k)} | {f[k]['summary'][:80]} |"
HEAD = '| Key | Type | Priority | Status | Component | Summary |\n|---|---|---|---|---|---|'

since = when(open(MARK).read()) if os.path.exists(MARK) else now - dt.timedelta(days=7)
new = [k for k in rank if when(f[k]['created']) > since and f[k]['issuetype']['name'] != 'Epic']

order, unlinked = checks(list(rank), f, a.epic_steps, ref_re)

review = [k for k in rank if f[k]['status']['name'].lower() == 'in review'
          and now - when(f[k]['statuscategorychangedate']) > dt.timedelta(days=a.review_days)]
stale = [k for k in rank if cat(k) == 'new' and now - when(f[k]['updated']) > dt.timedelta(days=a.stale_days)]

sec = lambda title, ks: f"\n## {title} ({len(ks)})\n\n" + (HEAD + '\n' + '\n'.join(map(row, ks)) if ks else 'None.') + '\n'
lst = lambda title, xs: f"\n## {title} ({len(xs)})\n\n" + ('\n'.join(xs) if xs else 'None.') + '\n'
md = (f"# {a.project} backlog check, {now:%Y-%m-%d}\n\n{len(rank)} open issues. "
      f"Last triage: {since:%Y-%m-%d}.\n"
      + sec('New since last triage: place on the board', new)
      + lst('Code named in new tickets', code_lines(new, f, link))
      + sec('No component: assign one', no_component(list(rank), f))
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
