"""rank.py's GitHub path against a fake `gh` on PATH, no network (SW-1187).

The fake serves a Projects (v2) board from a JSON file two items per page, so the pagination is walked,
and applies updateProjectV2ItemPosition to it; FAKE_DROP moves are accepted without moving, as GitHub can.
"""
import json, os, pathlib, subprocess, sys, tempfile, unittest

RANK = pathlib.Path(__file__).with_name('rank.py')
FAKE_GH = r'''#!PYTHON
import json, os, sys
state = os.environ['FAKE_BOARD']
b = json.load(open(state))
v = {}
for i, x in enumerate(sys.argv):
    if x in ('-f', '-F'):
        k, _, val = sys.argv[i + 1].partition('=')
        v[k] = val
if v['query'].startswith('mutation'):
    b['calls'].append(v.get('after'))
    if b['drop'] > 0:
        b['drop'] -= 1
    else:
        b['items'].remove(v['i'])
        b['items'].insert(b['items'].index(v['after']) + 1 if v.get('after') else 0, v['i'])
    json.dump(b, open(state, 'w'))
    print(json.dumps({'data': {'updateProjectV2ItemPosition': {'clientMutationId': None}}}))
    sys.exit(0)
start = int(v.get('after') or 0)
page = b['items'][start:start + 2]
print(json.dumps({'data': {'organization': {'projectV2': {'id': 'P1', 'items': {
    'pageInfo': {'hasNextPage': start + 2 < len(b['items']), 'endCursor': str(start + 2)},
    'nodes': [{'id': i, 'content': {'number': int(i[1:]), 'repository': {'nameWithOwner': 'o/r'}}} for i in page]
    + [{'id': 'D' + i, 'content': {}} for i in page[:1]]}}}}}))  # a draft card (no number) on every page
'''


class GitHubRank(unittest.TestCase):
    def run_rank(self, keys, items, drop=0):
        with tempfile.TemporaryDirectory() as d:
            gh = pathlib.Path(d, 'gh')
            gh.write_text(FAKE_GH.replace('PYTHON', sys.executable))
            gh.chmod(0o755)
            board = pathlib.Path(d, 'board.json')
            board.write_text(json.dumps({'items': items, 'drop': drop, 'calls': []}))
            env = {**os.environ, 'PATH': f'{d}{os.pathsep}{os.environ["PATH"]}', 'FAKE_BOARD': str(board)}
            r = subprocess.run([sys.executable, '-I', str(RANK), '--tracker', 'github', '--owner', 'o', '--board', '1', *keys],
                               capture_output=True, text=True, env=env, timeout=60)
            return r, json.loads(board.read_text())

    def test_orders_across_pages(self):
        # #5 to the top (no afterId); #4 is already below #5; #2 moves after #4, read back from page 3.
        r, b = self.run_rank(['o/r#5', 'o/r#4', 'o/r#2'], ['I1', 'I2', 'I3', 'I4', 'I5'])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(b['items'], ['I5', 'I1', 'I3', 'I4', 'I2'])
        self.assertEqual(b['calls'], [None, 'I4'])

    def test_dropped_move_is_retried(self):
        r, b = self.run_rank(['o/r#3'], ['I1', 'I2', 'I3'], drop=1)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(b['items'][0], 'I3')
        self.assertEqual(b['calls'], [None, None])

    def test_ref_not_on_board_exits_before_any_move(self):
        r, b = self.run_rank(['o/r#9'], ['I1', 'I2'])
        self.assertIn('not on board 1: o/r#9', r.stderr)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(b['calls'], [])


if __name__ == '__main__':
    unittest.main()
