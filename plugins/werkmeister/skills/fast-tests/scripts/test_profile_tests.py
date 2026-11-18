"""SW-812: the WAITING budget and the timeout path of profile_tests.py."""

import os
import shlex
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from profile_tests import run_one  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profile_tests.py")


def profile(cmd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, SCRIPT, "--cmd", cmd, "--fail-on-waiting", "--workers", "1", "unit"],
        capture_output=True,
        text=True,
        timeout=30,
    )


class ProfileTests(unittest.TestCase):
    def test_a_unit_that_sleeps_is_waiting_and_fails_the_budget(self):
        r = profile("sleep 2")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("unit: WAITING (", r.stdout)

    def test_a_quick_unit_passes_the_budget(self):
        r = profile(f"{shlex.quote(sys.executable)} -c pass")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("budget: all units within limits", r.stdout)

    def test_a_unit_past_its_timeout_is_killed_and_reported(self):
        self.assertEqual(run_one("sleep 5", "unit", None, 0.5)["exit"], "timeout")


if __name__ == "__main__":
    unittest.main()
