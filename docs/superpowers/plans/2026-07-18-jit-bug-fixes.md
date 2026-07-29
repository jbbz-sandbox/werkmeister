# JIT Context System Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four confirmed bugs in the JIT context system's runtime-injection and resolution code, and land the harness-7 precedence-line fix in the same pass.

**Architecture:** All changes are small, local edits to existing modules — no new files except tests. The three re-injection changes (wording, ordering, precedence line) land together in `apps/cli/src/commands/notes.ts`; the other fixes are one function each in `hooks_gen.ts`, `skill_gen.ts`, and `standards.ts`.

**Tech Stack:** Node 20+, vitest, uv-managed venv. Run tests from the repo root: `npx vitest run apps/cli/src/lib/__tests__/...`

## Global Constraints

- The `sandbox notes context` code path is a SessionStart hook payload: it must **never raise or block** — every new code path in it needs a broad exception guard, matching the existing `# noqa: BLE001` style.
- The hook harness truncates combined hook output at **10,000 chars** (documented at `apps/cli/src/commands/notes.ts:32-34`); the active-standards block must be emitted **before** anything that can push past that cap.
- `UNIVERSAL_STANDARDS` order is semantic: base (`comments`) first, in **tuple declaration order**, never alphabetical.
- No new dependencies. No changes to `docs/standards/` content. Match existing comment style (comments explain *why*, per `docs/standards/comments/STANDARD.md`).
- Commit style on this branch: `fix(jit): <description>` (see `git log --oneline -5`).
- Evidence anchors (cite in code comments where the plan shows them, nothing more): harness-7 (`docs/experiments/context-management/results/harness7.md`) proved the re-inject block re-anchors awareness but not compliance without a precedence directive.

---

### Task 1: Re-injection block — precedence line, truthful wording, truncation-safe ordering

Fixes three defects in one function cluster:
- **Bug 1:** the block always claims "compaction dropped the full rules" even on fresh `startup` sessions (the hook never reads the `source` field Claude Code passes on stdin), which can convince an agent standards are already loaded.
- **Bug 2:** the block is rendered **last**, after an unbounded number of decision notes (≤3,500 chars each) — the 10k harness truncation can silently drop it.
- **Harness-7 lever:** the block must re-deliver the *precedence framing* (rule wins over task framing), not just summaries — enriched summaries alone measured 0/3 applied.

**Files:**
- Modify: `apps/cli/src/commands/notes.ts` (functions `_render_active_standards`, `build_context`, `run`; add `_hook_source`)
- Test: `apps/cli/src/lib/__tests__/notes.test.ts`

**Interfaces:**
- Produces: `build_context(workspace: Path, source: str = "") -> str` (new optional param, default keeps all existing call sites working); `_hook_source() -> str` (module-private).
- Consumes: `standards_matching_diff`, `latest_handoff`, `open_decisions`, `skill_name_for` — all unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/lib/__tests__/notes.test.ts`. Reuse the existing fixture/monkeypatch style from `test_build_context_appends_active_standards` (line ~568) — it already monkeypatches `notes_cmd.standards_matching_diff`. Use this note-writing helper (add it near the new tests unless an equivalent already exists in the file):

```node
import io

def _write_note(tmp_path, num, note_type, body="body text", status="open"):
    d = tmp_path / ".sandbox" / "notes"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{num:03d}-{note_type}-t{num}.md").write_text(
        f"---\ntype: {note_type}\nphase: implement\nauthor: main\nstatus: {status}\n---\n{body}\n"
    )


def test_build_context_standards_block_precedes_notes_and_survives_10k(tmp_path, monkeypatch):
    # A handoff + three near-cap decision notes used to push the standards
    # block past the harness's 10k truncation point.
    _write_note(tmp_path, 1, "handoff", body="h" * 3400)
    for n in (2, 3, 4):
        _write_note(tmp_path, n, "decision", body="d" * 3400)
    monkeypatch.setattr(
        notes_cmd, "standards_matching_diff", lambda ws: [("ui", "UI standard summary.")]
    )
    out = notes_cmd.build_context(tmp_path)
    std = out.index("Active standards")
    assert std < out.index("Latest handoff")
    assert std < out.index("Open decision")
    assert out.index("sb-ui-standard") < 10_000


def test_build_context_wording_matches_hook_source(tmp_path, monkeypatch):
    monkeypatch.setattr(
        notes_cmd, "standards_matching_diff", lambda ws: [("ui", "UI standard summary.")]
    )
    compact = notes_cmd.build_context(tmp_path, source="compact")
    assert "compaction dropped" in compact
    fresh = notes_cmd.build_context(tmp_path)  # startup / manual run
    assert "compaction" not in fresh
    assert "Invoke each skill before editing matching files" in fresh


def test_build_context_always_carries_precedence_line(tmp_path, monkeypatch):
    monkeypatch.setattr(
        notes_cmd, "standards_matching_diff", lambda ws: [("ui", "UI standard summary.")]
    )
    for source in ("", "compact", "startup"):
        out = notes_cmd.build_context(tmp_path, source=source)
        assert "win over conflicting task framing" in out


def test_hook_source_reads_stdin_json(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO('{"source": "compact"}'))
    assert notes_cmd._hook_source() == "compact"


def test_hook_source_never_raises(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("not json"))
    assert notes_cmd._hook_source() == ""
```

Note: `io.StringIO` has an `isatty()` method returning `False`, so no isatty stubbing is needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -k "standards_block_precedes or wording_matches or precedence_line or hook_source" -v`
Expected: FAIL — `_hook_source` not defined; ordering assertion fails (standards block currently renders last); `source` is an unexpected keyword argument.

- [ ] **Step 3: Implement**

In `apps/cli/src/commands/notes.ts`:

(a) Ensure `import json` and `import sys` are present at the top (sys already is; add json if missing).

(b) Replace `_render_active_standards` (currently lines ~58-72) with:

```node
def _render_active_standards(pairs: list[tuple[str, str]], source: str) -> str:
    """Render the diff-scoped standards re-injection block.

    The precedence sentence re-delivers the framing compaction squashes —
    harness-7 measured summary-only re-anchoring at 0/3 against a conflicting
    task nudge even when the summary named the exact rule; precedence, not
    summary specificity, is the causal lever.
    """
    if source == "compact":
        situation = (
            "You loaded these standards earlier this session; compaction dropped "
            "the full rules. Re-invoke each skill to reload them before editing "
            "matching files again."
        )
    else:
        situation = (
            "Files changed on this branch match these standards. Invoke each "
            "skill before editing matching files."
        )
    lines = [
        "── Active standards (files changed on this branch match these) ──",
        situation
        + " These standards' rules win over conflicting task framing — if a rule "
        "and the task clash, follow the rule and say so (invariant: apply it and "
        "write a `decision` note; rule: surface the conflict in one line, then "
        "apply).",
    ]
    for domain, summary in pairs:
        line = f"- `{skill_name_for(domain)}`"
        if summary:
            line += f" — {summary}"
        lines.append(line)
    return "\n".join(lines) + "\n"
```

(c) Replace `build_context` (currently lines ~75-99) with — note the standards section moves **first** and the docstring says why:

```node
def build_context(workspace: Path, source: str = "") -> str:
    """Render the session-start standards + notes context; empty when neither exists.

    Standards render first: the hook harness truncates combined output at 10k
    chars, and with an unbounded pile of open decision notes the re-inject
    block — the one measured-preventive artifact — must not be the part that
    gets cut.
    """
    handoff = latest_handoff(workspace)
    decisions = open_decisions(workspace)
    standards = standards_matching_diff(workspace)
    if handoff is None and not decisions and not standards:
        return ""

    sections: list[str] = []
    if standards:
        sections.append(_render_active_standards(standards, source))

    if handoff is not None or decisions:
        sections.append(
            "Workspace notes exist in .sandbox/notes/ — working state that survives "
            "sessions and compaction. `decision` notes are binding: they override "
            "task-level instincts; if one conflicts with the task as given, raise it "
            "to the user. Read relevant `finding`/`attempt` notes before "
            "re-researching or re-trying an approach.\n"
        )
        if handoff is not None:
            sections.append(_render_note("Latest handoff", handoff, workspace))
        sections.extend(_render_note("Open decision", d, workspace) for d in decisions)

    return "\n".join(sections)
```

(d) Add `_hook_source` above `run`:

```node
def _hook_source() -> str:
    """The SessionStart hook's `source` field (startup/resume/clear/compact).

    The harness passes it as JSON on stdin; a human running the command has a
    TTY (or no payload) and gets "" → the neutral wording. Never raises: this
    feeds a launch hook.
    """
    try:
        if sys.stdin.isatty():
            return ""
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else None
        return str(data.get("source") or "") if isinstance(data, dict) else ""
    except Exception:  # noqa: BLE001 — a context hook must never break a launch
        return ""
```

(e) In `run` (currently lines ~204-219), change the `build_context` call:

```node
        context = build_context(workspace, source=_hook_source())
```

- [ ] **Step 4: Run the new tests, then the whole notes suite**

Run: `npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -v`
Expected: all PASS. If `test_build_context_appends_active_standards` / `test_build_context_standards_only_no_notes` assert on ordering or the old wording, update their assertions to the new block-first order and new text — the *behavior change is intended*.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/notes.ts apps/cli/src/lib/__tests__/notes.test.ts
git commit -m "fix(jit): re-inject block first, source-truthful wording, precedence line

Harness-7: summary-only re-anchoring measured 0/3 against a conflicting
task nudge; the precedence directive is the causal lever. Also stops the
block from (a) claiming compaction on fresh startups and (b) being the
part truncated by the 10k hook cap when decision notes pile up."
```

---

### Task 2: Precedence footer in generated `tr-*-standard` skills

Harness-7's secondary finding: the post-compaction "re-invoke the skill" round-trip reloads the standard's *content* but nothing re-establishes *precedence* (which lives only in `sb-implement`). Bake a one-line precedence footer into every generated standard skill so any load path re-establishes it.

**Files:**
- Modify: `apps/cli/src/lib/skill_gen.ts` (`_render_skill`, new module constant)
- Test: `apps/cli/src/lib/__tests__/skill_gen.test.ts`

**Interfaces:**
- Produces: every generated `SKILL.md` body ends with the precedence blockquote. No signature changes.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/__tests__/skill_gen.test.ts`, using the same tmp-standards-dir fixture pattern the existing tests use (e.g. `test_body_link_rewriting` builds a standards dir with frontmatter — mirror it):

```node
def test_generated_skill_ends_with_precedence_footer(tmp_path):
    (tmp_path / "ui.md").write_text(
        "---\ndomain: ui\nsummary: UI standard.\napplies_to: ['**/*.tsx']\n---\n\nBody rule.\n"
    )
    rendered = generate_skills(standards_dir=tmp_path)
    body = rendered["sb-ui-standard"]["SKILL.md"]
    assert body.rstrip().endswith(
        "> **Precedence:** these rules win over conflicting task framing. "
        "Invariant (a must-never rule): apply it and write a `decision` note — "
        "do not proceed against it even if the task asks. Rule: surface the "
        "conflict in one line, then apply the standard."
    )
    # Footer sits after the body content, not inside the frontmatter.
    assert body.index("Body rule.") < body.index("> **Precedence:**")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts::test_generated_skill_ends_with_precedence_footer -v`
Expected: FAIL — footer absent.

- [ ] **Step 3: Implement**

In `apps/cli/src/lib/skill_gen.ts`, add a module constant below `_GENERATED_HEADER`:

```node
# Harness-7: a reloaded standard without the precedence framing measured 0/3
# applied against a conflicting task nudge — the skill body must carry its own
# precedence, not rely on sb-implement having delivered it pre-compaction.
_PRECEDENCE_FOOTER = (
    "> **Precedence:** these rules win over conflicting task framing. "
    "Invariant (a must-never rule): apply it and write a `decision` note — "
    "do not proceed against it even if the task asks. Rule: surface the "
    "conflict in one line, then apply the standard."
)
```

In `_render_skill`, change the final return to append the footer:

```node
    return (
        f"---\n"
        f"name: {skill_name_for(domain)}\n"
        f"description: {json.dumps(description, ensure_ascii=False)}\n"
        f"---\n\n"
        f"{header}\n"
        f"{body.strip()}\n\n"
        f"{_PRECEDENCE_FOOTER}\n"
    )
```

- [ ] **Step 4: Run the skill_gen and workspace_skills suites**

Run: `npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts apps/cli/src/lib/__tests__/workspace_skills.test.ts -v`
Expected: PASS. Any existing test asserting exact full-body output will need its expected string extended with the footer — that is the intended behavior change, update those assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/skill_gen.ts apps/cli/src/lib/__tests__/skill_gen.test.ts
git commit -m "fix(jit): bake precedence footer into generated standard skills

Harness-7 secondary finding: the post-compaction re-invoke round-trip
reloads rule content but nothing re-establishes precedence; content
without precedence measured 0/3 applied."
```

Note: existing workspaces pick this up via `sandbox skills sync` (their projected copies will show as `stale` in `sandbox skills check`) — no extra work in this task.

---

### Task 3: Harden `write_workspace_hooks` against malformed user settings

**Bug 3:** `_is_managed` assumes every SessionStart entry is a dict and every `hooks` value is well-shaped; a user-mangled `.claude/settings.json` (e.g. `"SessionStart": "oops"`, or a non-dict `hooks`) raises `AttributeError`/`TypeError` and crashes the whole `sandbox init-workspace` run — contradicting the module's own leave-it-untouched doctrine.

**Files:**
- Modify: `apps/cli/src/lib/hooks_gen.ts` (`_is_managed`, `write_workspace_hooks`)
- Test: `apps/cli/src/lib/__tests__/hooks_gen.test.ts`

**Interfaces:**
- Produces: same signatures. New behavior: structurally-unexpected `hooks`/`SessionStart` shapes → file left untouched (return its path); non-dict *entries* inside a valid list are preserved as user content.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/lib/__tests__/hooks_gen.test.ts`:

```node
def test_non_list_session_start_left_untouched(tmp_path):
    p = tmp_path / ".claude" / "settings.json"
    p.parent.mkdir(parents=True)
    original = {"hooks": {"SessionStart": "not-a-list"}}
    p.write_text(json.dumps(original))
    write_workspace_hooks(tmp_path)
    assert json.loads(p.read_text()) == original


def test_non_dict_hooks_value_left_untouched(tmp_path):
    p = tmp_path / ".claude" / "settings.json"
    p.parent.mkdir(parents=True)
    original = {"hooks": ["not", "a", "dict"]}
    p.write_text(json.dumps(original))
    write_workspace_hooks(tmp_path)
    assert json.loads(p.read_text()) == original


def test_non_dict_entry_in_session_start_is_preserved(tmp_path):
    p = tmp_path / ".claude" / "settings.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"hooks": {"SessionStart": ["user-string-entry"]}}))
    write_workspace_hooks(tmp_path)
    entries = json.loads(p.read_text())["hooks"]["SessionStart"]
    assert "user-string-entry" in entries
    assert any(
        isinstance(e, dict) and _is_managed(e) for e in entries
    ), "managed hook should still be appended alongside the user entry"


def test_non_list_hooks_field_inside_entry_does_not_crash(tmp_path):
    p = tmp_path / ".claude" / "settings.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"hooks": {"SessionStart": [{"hooks": 42}]}}))
    write_workspace_hooks(tmp_path)  # must not raise
    entries = json.loads(p.read_text())["hooks"]["SessionStart"]
    assert {"hooks": 42} in entries
```

(Import `_is_managed` and `write_workspace_hooks` the same way the existing tests in this file do.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/hooks_gen.test.ts -k "non_list or non_dict" -v`
Expected: FAIL — `AttributeError: 'str' object has no attribute 'get'` (or `TypeError`) from `_is_managed` / the merge loop.

- [ ] **Step 3: Implement**

In `apps/cli/src/lib/hooks_gen.ts`, replace `_is_managed`:

```node
def _is_managed(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    inner = entry.get("hooks")
    if not isinstance(inner, list):
        return False
    return any(
        _HOOK_MARKER in hook.get("command", "")
        for hook in inner
        if isinstance(hook, dict)
    )
```

In `write_workspace_hooks`, replace the merge block (currently `hooks = settings.setdefault(...)` through `hooks["SessionStart"] = session_start`) with:

```node
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        return settings_path
    existing = hooks.get("SessionStart", [])
    if not isinstance(existing, list):
        return settings_path
    session_start = [entry for entry in existing if not _is_managed(entry)]
    session_start.append(build_session_start_entry())
    hooks["SessionStart"] = session_start
```

Also extend the docstring's untouched-cases sentence to mention structurally-unexpected `hooks`/`SessionStart` shapes.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run apps/cli/src/lib/__tests__/hooks_gen.test.ts -v`
Expected: all PASS (existing merge/preserve tests must still pass — the guards only add early-outs for malformed shapes).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/hooks_gen.ts apps/cli/src/lib/__tests__/hooks_gen.test.ts
git commit -m "fix(jit): don't crash init-workspace on malformed user settings.json hooks

Malformed nested shapes now get the same leave-it-untouched treatment
the docstring already promised for unparseable JSON."
```

---

### Task 4: Universal-standard ordering follows tuple declaration, not alphabet

**Bug 4:** `resolve_active_standards` sorts universals alphabetically; `("comments", "engineering")` only comes out base-first by alphabetical coincidence. A future third universal sorting before "comments" would silently demote the base rubric in every workspace's routing table. `standards_matching_diff` already does this correctly (iterates the tuple).

**Files:**
- Modify: `apps/cli/src/lib/standards.ts` (`resolve_active_standards`, one line)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts`

**Interfaces:**
- Produces: same signature; `active` list now ordered `UNIVERSAL_STANDARDS`-tuple-first-in-declared-order, then remaining keys alphabetical. (Identical output for today's tuple.)

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/__tests__/standards.test.ts` (import the `standards` module itself, e.g. `from cli.lib import standards`, matching the file's existing import style):

```node
def test_universal_ordering_follows_declared_tuple_not_alphabet(monkeypatch):
    # A hypothetical third universal sorting before "comments" must NOT jump
    # ahead of the declared base — this pins the mechanism, not today's
    # alphabetical coincidence.
    monkeypatch.setattr(standards, "UNIVERSAL_STANDARDS", ("zz-base", "aa-extra"))
    modules = {
        "zz-base": {"summary": "base"},
        "aa-extra": {"summary": "extra"},
        "ui": {"summary": "ui"},
    }
    active, not_active = standards.resolve_active_standards(
        [], {}, {}, modules=modules, archetypes={}
    )
    assert active == ["zz-base", "aa-extra"]
    assert not_active == ["ui"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts::test_universal_ordering_follows_declared_tuple_not_alphabet -v`
Expected: FAIL — `active == ["aa-extra", "zz-base"]` (alphabetical).

- [ ] **Step 3: Implement**

In `resolve_active_standards` (`apps/cli/src/lib/standards.ts`, currently line ~354), replace:

```node
    ordered = sorted(active, key=lambda k: (k not in UNIVERSAL_STANDARDS, k))
```

with:

```node
    # Universals in declared tuple order (base first) — standards_matching_diff
    # already honors the tuple; alphabetical here only matched by coincidence.
    ordered = sorted(
        active,
        key=lambda k: (
            (0, UNIVERSAL_STANDARDS.index(k), "")
            if k in UNIVERSAL_STANDARDS
            else (1, 0, k)
        ),
    )
```

- [ ] **Step 4: Run the standards suite**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -v`
Expected: all PASS, including the existing `test_universal_base_always_present` (output unchanged for today's tuple).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/standards.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "fix(jit): order universal standards by declared tuple, not alphabet"
```

---

### Task 5: Full verification pass

**Files:** none new.

- [ ] **Step 1: Run the entire sandbox-cli test suite**

Run: `npx vitest run apps/cli -q`
Expected: all pass (~340+ tests). Fix any assertion that pinned the old re-inject wording/ordering or the pre-footer skill bodies — those are intended behavior changes; anything else failing is a regression you introduced, fix the code not the test.

- [ ] **Step 2: Run the standards structural gate**

Run: `cd /Users/jayboyer/workspace/sandbox && ./sandbox standards check` (fallback if the subcommand name differs: `node apps/cli/dist/main.js standards check` from `apps/cli`).
Expected: exit 0, no errors.

- [ ] **Step 3: Smoke the hook payload end-to-end**

From a real initialized workspace directory (any under `$SANDBOX_WORKSPACES_ROOT`, or skip with a note if none exists):

Run: `echo '{"source":"compact"}' | sandbox notes context | head -20`
Expected: if the workspace has a branch diff, output starts with the `── Active standards` block including "compaction dropped" and the precedence sentence; with no stdin (`sandbox notes context </dev/null`) the wording is the neutral variant.

- [ ] **Step 4: Final commit if any test-only adjustments were made in this task**

```bash
git add -A apps/cli
git commit -m "test(jit): adjust assertions for re-inject ordering + skill footer"
```

---

## Explicitly out of scope (YAGNI — latent, not currently triggerable)

- Non-`.md` stray files invisible to `skills sync`/`check` pruning (`workspace_skills.ts:104,142`) — no module ships non-md files today.
- `_parse_frontmatter` `\n---` early-match fragility (`standards.ts:192`) — no multi-line frontmatter values exist today.
- Git octal-escaped non-ASCII path handling in `_changed_paths` (`standards.ts:93-99`).
- The `.claude/rules/` migration and the PreToolUse backstop — separate design docs, not bug fixes.
