#!/usr/bin/env python3
"""Extract and print the `starting_prompt` from a sandbox workspace.yml.

Walks up from the current directory (or --start) looking for
`.sandbox/workspace.yml`, then prints the `starting_prompt` value.

Exit codes:
  0  printed the starting_prompt
  1  no .sandbox/workspace.yml found
  2  found the file but it has no (non-empty) starting_prompt
"""
# Keeps the `str | None` annotations working on Python < 3.10.
from __future__ import annotations

import argparse
import os
import sys


def find_workspace_yml(start: str) -> str | None:
    cur = os.path.abspath(start)
    while True:
        for dot in (".werkmeister", ".sandbox"):  # new name first (SW-7)
            candidate = os.path.join(cur, dot, "workspace.yml")
            if os.path.isfile(candidate):
                return candidate
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def load_starting_prompt(path: str) -> str | None:
    try:
        import yaml  # type: ignore
    except ImportError:
        yaml = None

    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    if yaml is not None:
        data = yaml.safe_load(text) or {}
        value = data.get("starting_prompt")
        return value.strip() if isinstance(value, str) and value.strip() else None

    # Minimal fallback parser for `starting_prompt:` block scalars / quoted
    # strings, used only when PyYAML is unavailable.
    return _fallback_parse(text)


def _fallback_parse(text: str) -> str | None:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("starting_prompt:"):
            continue
        rest = line[len("starting_prompt:"):].strip()
        collected = [rest] if rest else []
        # Gather subsequent indented continuation lines.
        for cont in lines[i + 1:]:
            if cont and not cont[0].isspace():
                break
            collected.append(cont.strip())
        raw = " ".join(p for p in collected if p != "").strip()
        # Strip surrounding single/double quotes and unescape YAML '' -> '.
        if len(raw) >= 2 and raw[0] in "'\"" and raw[-1] == raw[0]:
            quote = raw[0]
            raw = raw[1:-1]
            if quote == "'":
                raw = raw.replace("''", "'")
        return raw.strip() or None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=".", help="directory to start searching from")
    args = ap.parse_args()

    path = find_workspace_yml(args.start)
    if not path:
        print("No .sandbox/workspace.yml found from", os.path.abspath(args.start), file=sys.stderr)
        return 1

    prompt = load_starting_prompt(path)
    if not prompt:
        print(f"Found {path} but it has no starting_prompt", file=sys.stderr)
        return 2

    print(prompt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
