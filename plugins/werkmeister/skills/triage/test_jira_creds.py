"""Where the triage scripts take Jira credentials from (SW-994, SW-945), against a local HTTP stub.

The CLI's order: JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN in the environment, then the token in
secrets.env and the jira: block of config.yaml (both beside WERKMEISTER_CONFIG_FILE). With none of
them, each script exits non-zero naming both sources instead of a traceback.
"""
import base64, http.server, os, pathlib, subprocess, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).parent
SCRIPTS = {'rank.py': ['SW-1'], 'report.py': ['--project', 'SW', '--board', '1'], 'apply.py': ['PLAN']}


class Stub(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):
        Stub.seen.append(self.headers.get('Authorization', ''))
        self.send_response(500)
        self.end_headers()

    do_POST = do_PUT = do_GET

    def log_message(self, *a):
        pass


class JiraCreds(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.d.name)
        (self.home / '.werkmeister').mkdir()
        self.srv = http.server.HTTPServer(('127.0.0.1', 0), Stub)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_port}'
        Stub.seen = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.d.cleanup()

    def run_script(self, name, env=None):
        plan = self.home / 'plan.json'
        plan.write_text('{"rank": ["SW-1", "SW-2"]}')
        args = [str(plan) if a == 'PLAN' else a for a in SCRIPTS[name]]
        base = {k: v for k, v in os.environ.items() if not k.startswith(('JIRA_', 'WERKMEISTER_'))}
        return subprocess.run([sys.executable, '-I', str(HERE / name), *args], capture_output=True, text=True,
                              env={**base, 'HOME': str(self.home), 'RANK_RETRY_DELAY': '0', **(env or {})}, timeout=60)

    def auth(self, email, token):
        return 'Basic ' + base64.b64encode(f'{email}:{token}'.encode()).decode()

    def test_no_credentials_names_both_sources(self):
        for name in SCRIPTS:
            with self.subTest(name):
                r = self.run_script(name)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn('Traceback', r.stderr)
                self.assertIn('JIRA_API_TOKEN', r.stderr)
                self.assertIn('jira:', r.stderr)

    def test_env_wins_over_the_config_block(self):
        (self.home / '.werkmeister/config.yaml').write_text(
            'jira:\n  base_url: http://127.0.0.1:9\n  email: yaml@x\n  api_token: yaml-tok\n')
        for name in ('rank.py', 'report.py'):
            with self.subTest(name):
                Stub.seen = []
                self.run_script(name, {'JIRA_BASE_URL': self.url, 'JIRA_EMAIL': 'env@x', 'JIRA_API_TOKEN': 'env-tok'})
                self.assertEqual(Stub.seen[:1], [self.auth('env@x', 'env-tok')])

    def test_secrets_env_token_beside_a_relocated_config(self):
        cfg = self.home / 'scratch' / 'config.yaml'
        cfg.parent.mkdir()
        cfg.write_text(f'jira:\n  base_url: {self.url}\n  email: yaml@x\n  api_token: stale-tok\n')  # secrets.env wins
        (cfg.parent / 'secrets.env').write_text('JIRA_API_TOKEN=old-tok\nOTHER=1\nJIRA_API_TOKEN=sec-tok\n')  # last line wins
        for name in ('rank.py', 'report.py'):
            with self.subTest(name):
                Stub.seen = []
                self.run_script(name, {'WERKMEISTER_CONFIG_FILE': str(cfg)})
                self.assertEqual(Stub.seen[:1], [self.auth('yaml@x', 'sec-tok')])


if __name__ == '__main__':
    unittest.main()
