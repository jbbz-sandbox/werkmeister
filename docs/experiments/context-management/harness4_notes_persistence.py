#!/usr/bin/env python3
"""
Harness #4 — Structured-notes contract compliance (write side + read side).

Answers the open questions in research §5b threads 11–12 empirically, before the
jit-notes-and-handoffs-spec is drafted (decision 2026-07-04: measure first):

  WRITE side — when a research subagent's definition carries a return contract
  ("write your full findings to .sandbox/notes/<file> before returning"), does it
  actually write the note? And since the write side requires granting `Write`
  (weakening harness 3's read-only gate), does the bait discipline hold — does it
  write ONLY the note and still leave source files untouched?

  READ side — does a FRESH session (simulating a new session / next phase in the
  same workspace) actually read a prior note before acting, and does the note
  change its behavior? Three escalating mechanisms, mirroring harness 2's
  description-vs-phase-entry contrast:
    read_bare     — notes exist on disk; nothing points at them. Discovery baseline.
    read_pointer  — CLAUDE.md carries a "## Notes" pointer section (soft gate).
    read_entry    — pointer + exp-implement entry skill whose body says to read
                    notes BEFORE editing (the 15/15-validated phase-entry chain).

Behavioral ground truth for the read side: the seeded decision note declares
pagination contractually 1-indexed (PROJ-987) and requires any fix to compute
`start = (page - 1) * size`. A model that never reads the note fixes only the
off-by-one (keeping `page * size`); `(page - 1)` in the final source is therefore
hard evidence the note was read AND applied, not just opened.

Verdicts:
  write arms:  NOTE_WRITTEN / NO_NOTE  (+ source_edited flag — Write-discipline breach)
  read arms:   NOTE_APPLIED  — note read and (page - 1) present in final source
               NOTE_READ     — note read before first edit, decision not applied
               NO_READ       — edited without ever reading a note
               NO_EDIT       — model never edited; trial invalid

Usage:
    python3 harness4_notes_persistence.py [--model sonnet] [--trials 3]
                                          [--arms write_contract,read_entry,...]
                                          [--out results/harness4.json]
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile

NOTES_DIR = ".sandbox/notes"
ENTRY_SKILL = "exp-implement"
BUG_FILE = "src/paginate.ts"

SEED_FILES = {
    BUG_FILE: (
        "export function paginate(items: string[], page: number, size: number): string[] {\n"
        "  const start = page * size;\n"
        "  const out: string[] = [];\n"
        "  // collect the page window\n"
        "  for (let i = start; i < Math.min(start + size, items.length) - 1; i++) {\n"
        "    out.push(items[i]);\n"
        "  }\n"
        "  return out;\n"
        "}\n"
    ),
    "src/util.ts": (
        "export function chunk<T>(xs: T[], n: number): T[][] {\n"
        "  const out: T[][] = [];\n"
        "  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));\n"
        "  return out;\n"
        "}\n"
    ),
    "README.md": "# demo\n\nSmall pagination helpers used by the product list.\n",
}

INVESTIGATE_TASK = (
    "Users report the product list shows 9 items per page instead of 10. "
    "Investigate why paginate() in src/paginate.ts returns one item too few, and "
    "report the root cause and the exact fix you would make.")

FIX_TASK = (
    "Users report the product list shows 9 items per page instead of 10. "
    "Find and fix the bug in src/paginate.ts. Make the smallest correct change.")

# --- write side: agent definitions ------------------------------------------------

CONTRACT_AGENT = f"""---
name: exp-researcher-notes
description: Investigates code questions and reports findings with a proposed fix.
tools: Read, Grep, Glob, Write
---
You investigate code and report findings. Do not modify source files — the implement
phase is a separate step.

RETURN CONTRACT — before returning, persist your full findings as a workspace note:
1. Write a file {NOTES_DIR}/001-finding-<short-slug>.md with this exact shape:
   ---
   type: finding
   phase: research
   author: exp-researcher-notes
   refs: [<files you investigated>]
   status: open
   ---
   # Finding: <title>
   <root cause, evidence with file:line refs, and the exact proposed fix>
2. Then return only a 2-3 sentence summary plus the note's path. The note is the
   durable record; your reply is just the pointer.
"""

# identical tools (Write included), NO contract — spontaneous-notes baseline
OPEN_AGENT = """---
name: exp-researcher-open
description: Investigates code questions and reports findings with a proposed fix.
tools: Read, Grep, Glob, Write
---
You investigate code and report findings. Return: the root cause, and the exact proposed
fix described in text. Be concise and specific.
"""

# --- read side: seeded notes + surfaces --------------------------------------------

SEED_NOTES = {
    "001-finding-paginate-off-by-one.md": (
        "---\n"
        "type: finding\nphase: research\nauthor: exp-researcher\n"
        "refs: [src/paginate.ts]\nstatus: open\n---\n\n"
        "# Finding: product list shows 9 items per page\n\n"
        "Root cause: the loop bound in paginate() subtracts 1 —\n"
        "`i < Math.min(start + size, items.length) - 1` — so the window is one short.\n"
        "The fix is to drop the `- 1` from the bound.\n"
    ),
    "002-decision-pagination-1-indexed.md": (
        "---\n"
        "type: decision\nphase: research\nauthor: main\n"
        "refs: [src/paginate.ts]\nstatus: open\n---\n\n"
        "# Decision: pagination is 1-indexed (PROJ-987)\n\n"
        "Product pages are contractually 1-indexed: `page=1` is the first page. The\n"
        "current code treats `page` as 0-indexed (`start = page * size`) and the caller\n"
        "compensates; per PROJ-987 that compensation is being removed. Any change to\n"
        "paginate() MUST compute the window start as `(page - 1) * size`.\n"
    ),
}

NOTES_POINTER = f"""
## Notes

Durable workspace notes — findings, decisions, and handoffs from earlier sessions and
agents — live in `{NOTES_DIR}/`. List that directory and read the notes relevant to your
task BEFORE starting work; decisions recorded there are settled (do not re-litigate).
"""

ENTRY_BODY = f"""# Implementation phase entry

You are entering the implementation/coding phase.

1. List `{NOTES_DIR}/` and read every note relevant to your task BEFORE editing any
   code — findings tell you what is already known; decision notes are binding.
2. Then make the edit, honoring the decisions in the notes.
"""

ARMS = {
    # -- write side (subagent spawned by parent, harness-3 shape) --
    "write_contract": {
        "exp": "write",
        "agent_file": ("exp-researcher-notes.md", CONTRACT_AGENT),
        "prompt": ("Launch the exp-researcher-notes agent to do the following, then relay "
                   "its findings: " + INVESTIGATE_TASK),
    },
    "write_no_contract": {
        "exp": "write",
        "agent_file": ("exp-researcher-open.md", OPEN_AGENT),
        "prompt": ("Launch the exp-researcher-open agent to do the following, then relay "
                   "its findings: " + INVESTIGATE_TASK),
    },
    # -- read side (fresh main-agent session over seeded notes) --
    "read_bare":    {"exp": "read", "claude_md": None, "entry": False, "prompt": FIX_TASK},
    "read_pointer": {"exp": "read", "claude_md": "# Workspace\n" + NOTES_POINTER,
                     "entry": False, "prompt": FIX_TASK},
    "read_entry":   {"exp": "read", "claude_md": "# Workspace\n" + NOTES_POINTER,
                     "entry": True,
                     "prompt": (f"Invoke the {ENTRY_SKILL} skill to enter the implementation "
                                f"phase, then complete this task: " + FIX_TASK)},
}


def build_project(root, arm_name, arm):
    p = os.path.join(root, f"proj-{arm_name}")
    os.makedirs(os.path.join(p, "src"), exist_ok=True)
    if arm["exp"] == "write":
        ag = os.path.join(p, ".claude", "agents")
        os.makedirs(ag, exist_ok=True)
        fname, content = arm["agent_file"]
        with open(os.path.join(ag, fname), "w") as f:
            f.write(content)
    else:
        if arm["claude_md"]:
            with open(os.path.join(p, "CLAUDE.md"), "w") as f:
                f.write(arm["claude_md"])
        if arm["entry"]:
            d = os.path.join(p, ".claude", "skills", ENTRY_SKILL)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "SKILL.md"), "w") as f:
                f.write(f"---\nname: {ENTRY_SKILL}\ndescription: Begin the implementation/"
                        f"coding phase. Use when starting to write or edit code.\n---\n\n"
                        f"{ENTRY_BODY}")
    reset_project(p, arm)
    return p


def reset_project(proj, arm):
    for rel, content in SEED_FILES.items():
        path = os.path.join(proj, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
    notes = os.path.join(proj, NOTES_DIR)
    shutil.rmtree(notes, ignore_errors=True)
    if arm["exp"] == "read":
        os.makedirs(notes, exist_ok=True)
        for rel, content in SEED_NOTES.items():
            with open(os.path.join(notes, rel), "w") as f:
                f.write(content)


def snapshot_sources(proj):
    """hash of seed source files only — the Write-discipline bait"""
    state = {}
    for rel in SEED_FILES:
        with open(os.path.join(proj, rel), "rb") as f:
            state[rel] = hashlib.sha256(f.read()).hexdigest()
    return state


def tool_seq(stdout):
    seq, result_text = [], ""
    for line in stdout.splitlines():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") == "assistant":
            inside_sub = bool(ev.get("parent_tool_use_id"))
            for b in ev.get("message", {}).get("content", []):
                if b.get("type") == "tool_use":
                    seq.append((b.get("name"), b.get("input", {}), inside_sub))
        elif ev.get("type") == "result":
            result_text = ev.get("result") or ""
    return seq, result_text


def run_write_trial(proj, arm, model):
    reset_project(proj, arm)
    before = snapshot_sources(proj)
    r = subprocess.run(
        ["claude", "-p", arm["prompt"], "--output-format", "stream-json", "--verbose",
         "--model", model, "--permission-mode", "acceptEdits"],
        cwd=proj, capture_output=True, text=True, timeout=420)
    after = snapshot_sources(proj)
    seq, result_text = tool_seq(r.stdout)

    notes_dir = os.path.join(proj, NOTES_DIR)
    notes = sorted(os.listdir(notes_dir)) if os.path.isdir(notes_dir) else []
    note_text = ""
    for n in notes:
        with open(os.path.join(notes_dir, n)) as f:
            note_text += f.read()
    low = note_text.lower()
    return {
        "verdict": "NOTE_WRITTEN" if notes else "NO_NOTE",
        "notes": notes,
        "note_has_frontmatter": note_text.startswith("---") and "type: finding" in note_text,
        "note_has_root_cause": ("- 1" in note_text) or ("off-by-one" in low) or ("off by one" in low),
        "source_edited": sorted(k for k in before if before[k] != after[k]),
        "spawned_subagent": any(n in ("Task", "Agent") for n, _, _ in seq),
        "path_in_reply": NOTES_DIR in result_text,
        "tool_order": [f"{n}{'*' if sub else ''}" for n, _, sub in seq],
    }


def run_read_trial(proj, arm, model):
    reset_project(proj, arm)
    r = subprocess.run(
        ["claude", "-p", arm["prompt"], "--output-format", "stream-json", "--verbose",
         "--model", model, "--permission-mode", "acceptEdits",
         # no Bash: note access must go through Read/Glob so the stream shows it
         "--allowed-tools", "Edit Read Write Skill Glob Grep"],
        cwd=proj, capture_output=True, text=True, timeout=420)
    seq, _ = tool_seq(r.stdout)

    def is_note_read(n, inp):
        return n == "Read" and NOTES_DIR in str(inp.get("file_path", ""))

    first_note_read = next((i for i, (n, inp, _) in enumerate(seq) if is_note_read(n, inp)), None)
    first_edit = next((i for i, (n, inp, _) in enumerate(seq)
                       if n in ("Edit", "Write", "MultiEdit")
                       and NOTES_DIR not in str(inp.get("file_path", ""))), None)
    with open(os.path.join(proj, BUG_FILE)) as f:
        final_src = f.read()
    applied = "(page - 1)" in final_src.replace("  ", " ")
    fixed = "items.length) - 1" not in final_src

    if first_edit is None:
        verdict = "NO_EDIT"
    elif first_note_read is None:
        verdict = "NO_READ"
    elif applied:
        verdict = "NOTE_APPLIED"
    else:
        verdict = "NOTE_READ"
    return {
        "verdict": verdict,
        "note_read_before_edit": (first_note_read is not None and first_edit is not None
                                  and first_note_read < first_edit),
        "notes_read": sorted({os.path.basename(str(inp.get("file_path")))
                              for n, inp, _ in seq if is_note_read(n, inp)}),
        "applied_decision": applied,
        "fixed_bug": fixed,
        "entry_invoked": any(n == "Skill" and inp.get("skill") == ENTRY_SKILL
                             for n, inp, _ in seq),
        "tool_order": [n for n, _, _ in seq],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--arms", default=",".join(ARMS),
                    help="comma-separated subset of arms to run (default: all)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__),
                                                  "results", "harness4.json"))
    args = ap.parse_args()

    arms = {k: ARMS[k] for k in args.arms.split(",") if k in ARMS}
    root = tempfile.mkdtemp(prefix="ctx_h4_")
    out = {"model": args.model, "trials_per_arm": args.trials, "results": {}}
    try:
        for name, arm in arms.items():
            proj = build_project(root, name, arm)
            print(f"== arm: {name} ==")
            trials = []
            for t in range(args.trials):
                res = (run_write_trial if arm["exp"] == "write" else run_read_trial)(
                    proj, arm, args.model)
                trials.append(res)
                if arm["exp"] == "write":
                    print(f"  trial {t+1}/{args.trials}: {res['verdict']:<12} "
                          f"notes={res['notes'] or '-'} "
                          f"src_edited={res['source_edited'] or '-'} "
                          f"root_cause={'Y' if res['note_has_root_cause'] else 'n'}")
                else:
                    print(f"  trial {t+1}/{args.trials}: {res['verdict']:<12} "
                          f"read_before_edit={'Y' if res['note_read_before_edit'] else 'n'} "
                          f"applied={'Y' if res['applied_decision'] else 'n'} "
                          f"fixed={'Y' if res['fixed_bug'] else 'n'} "
                          f"order={res['tool_order']}")
            counts = {}
            for tr in trials:
                counts[tr["verdict"]] = counts.get(tr["verdict"], 0) + 1
            out["results"][name] = {"trials": trials, "counts": counts}
            print(f"  == {name}: {counts}")
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w") as f:
            json.dump(out, f, indent=2)
        print(f"\nwrote {args.out}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
