#!/usr/bin/env python3
"""
Harness #1 — Token model of Claude Code skills.

Answers open thread #1 in docs/context-management-research.md empirically:
  - What does a surfaced skill actually cost in STANDING context (always in the
    prompt, before any invocation)?
  - Does description length drive that cost?
  - Are skill BODIES truly lazy (zero standing cost until invoked)?

Method: run trivial headless `claude -p` sessions with N synthetic skills placed
in an ephemeral project's .claude/skills/, and read real token usage from the
JSON output. Standing prompt size is measured as a cache-invariant total:
    total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
The absolute number includes the whole baseline (system prompt, MCP tools, the
user's existing skills, CLAUDE.md) — that baseline is CONSTANT across configs, so
the delta vs. an empty-project baseline isolates the per-skill cost.

Caveat: this measures HEADLESS `claude -p`. The interactive TUI may surface skill
descriptions differently (see RESULTS.md).

Usage:
    python3 harness1_token_model.py [--model sonnet] [--reps 1] [--out results/harness1.json]
"""
import argparse, json, os, shutil, subprocess, tempfile, statistics, sys

FILL = ("graphql schema resolver federation pagination cursor nullability dataloader "
        "batching hydration cache-key react component effect ordering ") * 4000

def write_skill(skills_dir, name, desc, body):
    d = os.path.join(skills_dir, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w") as f:
        f.write(f"---\nname: {name}\ndescription: {desc}\n---\n\n{body}\n")

def make_project(root, tag, n_skills, desc_tokens, body_tokens):
    p = os.path.join(root, tag)
    sk = os.path.join(p, ".claude", "skills")
    os.makedirs(sk, exist_ok=True)
    for i in range(n_skills):
        desc = FILL[: desc_tokens * 4] if desc_tokens else f"standard {i} use when editing domain {i}"
        write_skill(sk, f"exp-{i:03d}", desc, FILL[: body_tokens * 4])
    return p

def total_prompt_tokens(path, model, reps):
    vals = []
    for _ in range(reps):
        r = subprocess.run(
            ["claude", "-p", "Reply with exactly: OK", "--output-format", "json",
             "--model", model, "--permission-mode", "plan"],
            cwd=path, capture_output=True, text=True, timeout=180)
        try:
            u = json.loads(r.stdout)["usage"]
            vals.append(u["input_tokens"]
                        + u.get("cache_creation_input_tokens", 0)
                        + u.get("cache_read_input_tokens", 0))
        except Exception as e:
            print(f"  [warn] parse failed: {e}\n  stdout={r.stdout[:200]}\n  stderr={r.stderr[:200]}",
                  file=sys.stderr)
    return int(statistics.median(vals)) if vals else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "results", "harness1.json"))
    args = ap.parse_args()

    root = tempfile.mkdtemp(prefix="ctx_h1_")
    out = {"model": args.model, "reps": args.reps, "metric": "input+cache_creation+cache_read"}
    try:
        base = total_prompt_tokens(make_project(root, "n0", 0, 0, 0), args.model, args.reps)
        print(f"baseline (0 skills): {base}")

        # A) count sweep — desc ~60 tok, body ~2000 tok each
        out["count_sweep"] = {"baseline": base, "points": []}
        for n in (5, 20, 50):
            t = total_prompt_tokens(make_project(root, f"n{n}", n, 60, 2000), args.model, args.reps)
            per = round((t - base) / n, 2)
            print(f"  N={n:<3}: total={t}  delta={t-base}  per_skill={per}")
            out["count_sweep"]["points"].append({"n": n, "total": t, "delta": t - base, "per_skill": per})

        # B) description-size sweep — 1 skill, vary description length
        out["desc_sweep"] = []
        for dt in (50, 300, 1000, 3000):
            t = total_prompt_tokens(make_project(root, f"d{dt}", 1, dt, 0), args.model, args.reps)
            print(f"  desc~{dt:<5}tok (1 skill): total={t}  delta={t-base}")
            out["desc_sweep"].append({"desc_tokens": dt, "total": t, "delta": t - base})

        # C) body laziness — N=20 fixed, vary body size
        out["body_sweep"] = []
        for bt in (100, 4000):
            t = total_prompt_tokens(make_project(root, f"b{bt}", 20, 60, bt), args.model, args.reps)
            print(f"  N=20 body~{bt:<5}tok: total={t}")
            out["body_sweep"].append({"n": 20, "body_tokens": bt, "total": t})

        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(out, f, indent=2)
        print(f"\nwrote {args.out}")
    finally:
        shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    main()
