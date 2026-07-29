#!/usr/bin/env python3
"""
Harness #2 — Skill trigger *timing* reliability.

Answers open thread #2 in docs/context-management-research.md empirically:
  When a domain standard is gated only by a description ("Use when EDITING
  GraphQL…"), does the model invoke the skill BEFORE it writes the first draft,
  or does it start editing first (so the standard can't shape the first pass)?

This is the load-bearing question behind the design decision that ponytail /
prevention-critical rules must load at PHASE ENTRY, not on the edit event
(§3.7 of the research doc). If description-triggering reliably fires *before*
the first edit, description-gating is enough; if it often fires late or not at
all, a deterministic phase-entry loader must be primary.

Method: an ephemeral project with three domain skills (graphql / ui / api),
each gated purely by its description. For each domain, ask the model to make a
concrete edit to a matching file, capture the ordered tool-call stream
(--output-format stream-json), and classify:

  PREVENTIVE  — domain Skill invoked BEFORE the first Edit/Write   (good)
  LATE        — first Edit/Write happened BEFORE the Skill          (miss)
  NO_TRIGGER  — domain Skill never invoked                          (miss)
  NO_EDIT     — model never edited; trial invalid

Arms (--arm):
  description  — the original pilot: skills gated ONLY by description; plain task prompt.
  phase-entry  — the recommended fix (research §3.7 / spec §5.6): the project carries a
                 CLAUDE.md "Standards routing" table + an `exp-implement` entry skill whose
                 body says "load the matching standard BEFORE editing"; the task prompt
                 explicitly enters the phase. Measures whether the entry chain
                 (entry skill → routing table → domain skill → edit) reliably drives the
                 standard into context before the first edit — i.e. whether it fixes the
                 0/6 NO_TRIGGER on ui/api. Also records ENTRY-MISS (entry skill itself
                 never invoked) separately from the domain verdict.
  both         — run both arms (default).

Usage:
    python3 harness2_trigger_timing.py [--model sonnet] [--trials 3] [--arm both]
                                       [--domains graphql,ui,api] [--out results/harness2.json]
"""
import argparse, json, os, shutil, subprocess, tempfile, sys

ENTRY_SKILL = "exp-implement"

DOMAINS = {
    "graphql": {
        "skill": "exp-graphql-standard",
        "desc": ("Sandbox GraphQL coding standard. Use when EDITING OR IMPLEMENTING "
                 "GraphQL — .graphql files, resolvers, federation @key directives. Not for research."),
        "rule": "Every @key directive MUST carry a comment explaining subgraph ownership.",
        "file": "src/schema.graphql",
        "seed": "type Product {\n  id: ID!\n  name: String!\n}\n",
        "task": "Add a `reviewCount: Int!` field to the Product type in src/schema.graphql.",
    },
    "ui": {
        "skill": "exp-ui-standard",
        "desc": ("Sandbox UI coding standard. Use when EDITING OR IMPLEMENTING frontend — "
                 ".tsx/.jsx React components, hooks, render/effect ordering. Not for research."),
        "rule": "Every effect with external deps MUST carry a comment on why it runs where it does.",
        "file": "src/Button.tsx",
        "seed": "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n",
        "task": "Add a `disabled?: boolean` prop to the Button component in src/Button.tsx and use it.",
    },
    "api": {
        "skill": "exp-api-standard",
        "desc": ("Sandbox API coding standard. Use when EDITING OR IMPLEMENTING REST/service "
                 "handlers — controllers, request/response types, endpoint code. Not for research."),
        "rule": "Every endpoint MUST carry a comment on its error/nullability contract.",
        "file": "src/handler.ts",
        "seed": "export function getProduct(id: string) {\n  return db.find(id);\n}\n",
        "task": "Add an `includeReviews?: boolean` parameter to getProduct in src/handler.ts.",
    },
}

ROUTING_TABLE = """# Experiment project

## Standards routing
> Compiled table — which coding standard applies to which files.

| Standard | Skill                 | Loads on                          |
|----------|-----------------------|-----------------------------------|
| graphql  | `exp-graphql-standard`| *.graphql, resolvers              |
| ui       | `exp-ui-standard`     | *.tsx, *.jsx React components     |
| api      | `exp-api-standard`    | *.ts service handlers/controllers |
"""

ENTRY_BODY = """# Implementation phase entry

You are entering the implementation/coding phase.

1. Read the "Standards routing" table in this project's CLAUDE.md.
2. BEFORE writing or editing any code, invoke the Skill tool for every routing row whose
   "Loads on" pattern matches a file you are about to edit. The standard must be in context
   before your first edit.
3. Then make the edit, following the loaded standards.
"""

def build_project(root, phase_entry=False):
    p = os.path.join(root, "proj-entry" if phase_entry else "proj-desc")
    sk = os.path.join(p, ".claude", "skills")
    os.makedirs(sk, exist_ok=True)
    os.makedirs(os.path.join(p, "src"), exist_ok=True)
    for dom in DOMAINS.values():
        d = os.path.join(sk, dom["skill"])
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w") as f:
            f.write(f"---\nname: {dom['skill']}\ndescription: {dom['desc']}\n---\n\n"
                    f"# Standard\n{dom['rule']}\n")
    if phase_entry:
        with open(os.path.join(p, "CLAUDE.md"), "w") as f:
            f.write(ROUTING_TABLE)
        d = os.path.join(sk, ENTRY_SKILL)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w") as f:
            f.write(f"---\nname: {ENTRY_SKILL}\ndescription: Begin the implementation/coding "
                    f"phase. Use when starting to write or edit code.\n---\n\n{ENTRY_BODY}")
    return p

def reset_file(proj, dom):
    with open(os.path.join(proj, dom["file"]), "w") as f:
        f.write(dom["seed"])

def run_trial(proj, dom, model, arm):
    reset_file(proj, dom)
    if arm == "phase-entry":
        # Deterministic, user-driven phase entry (spec §5.6): the user explicitly enters the
        # implementation phase. Explicit Skill-tool wording (not "/exp-implement") so the
        # invocation shows up as a tool_use event we can order against the first edit.
        prompt = (f"Invoke the {ENTRY_SKILL} skill to enter the implementation phase, "
                  f"then complete this task: {dom['task']}")
    else:
        prompt = dom["task"]
    r = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
         "--model", model, "--permission-mode", "acceptEdits",
         "--allowed-tools", "Edit Read Write Skill"],
        cwd=proj, capture_output=True, text=True, timeout=240)
    seq = []
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") == "assistant":
            for b in ev.get("message", {}).get("content", []):
                if b.get("type") == "tool_use":
                    seq.append((b.get("name"), b.get("input", {})))
    first_skill = next((i for i, (n, inp) in enumerate(seq)
                        if n == "Skill" and inp.get("skill") == dom["skill"]), None)
    first_entry = next((i for i, (n, inp) in enumerate(seq)
                        if n == "Skill" and inp.get("skill") == ENTRY_SKILL), None)
    first_edit = next((i for i, (n, _) in enumerate(seq)
                       if n in ("Edit", "Write", "MultiEdit")), None)
    if first_edit is None:
        verdict = "NO_EDIT"
    elif first_skill is None:
        verdict = "NO_TRIGGER"
    elif first_skill < first_edit:
        verdict = "PREVENTIVE"
    else:
        verdict = "LATE"
    res = {"verdict": verdict, "first_skill_idx": first_skill, "first_edit_idx": first_edit,
           "tool_order": [n for n, _ in seq]}
    if arm == "phase-entry":
        res["entry_invoked"] = first_entry is not None
        res["entry_before_edit"] = (first_entry is not None and first_edit is not None
                                    and first_entry < first_edit)
    return res

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--arm", choices=["description", "phase-entry", "both"], default="both")
    ap.add_argument("--domains", default=",".join(DOMAINS),
                    help="comma-separated subset of domains to run (default: all)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "results", "harness2.json"))
    args = ap.parse_args()

    arms = ["description", "phase-entry"] if args.arm == "both" else [args.arm]
    domains = {k: DOMAINS[k] for k in args.domains.split(",") if k in DOMAINS}
    root = tempfile.mkdtemp(prefix="ctx_h2_")
    out = {"model": args.model, "trials_per_domain": args.trials, "arms": {}}
    try:
        for arm in arms:
            proj = build_project(root, phase_entry=(arm == "phase-entry"))
            print(f"== arm: {arm} ==")
            arm_out = {}
            for name, dom in domains.items():
                trials = []
                for t in range(args.trials):
                    res = run_trial(proj, dom, args.model, arm)
                    trials.append(res)
                    extra = ""
                    if arm == "phase-entry":
                        extra = f" entry={'Y' if res.get('entry_invoked') else 'MISS'}"
                    print(f"  {name} trial {t+1}/{args.trials}: {res['verdict']:<11}{extra} "
                          f"order={res['tool_order']}")
                counts = {}
                for tr in trials:
                    counts[tr["verdict"]] = counts.get(tr["verdict"], 0) + 1
                arm_out[name] = {"trials": trials, "counts": counts}
                if arm == "phase-entry":
                    arm_out[name]["entry_invoked"] = sum(
                        1 for tr in trials if tr.get("entry_invoked"))
                print(f"  == {name}: {counts}")
            out["arms"][arm] = arm_out
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(out, f, indent=2)
        print(f"\nwrote {args.out}")
    finally:
        shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    main()
