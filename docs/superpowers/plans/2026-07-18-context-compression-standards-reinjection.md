# Diff-scoped active-standards re-injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On session start (compaction included), re-inject the one-liners of standards whose `applies_to` globs match the current branch diff, plus a re-invoke directive, so a mid-edit agent re-loads standards whose full text was squashed.

**Architecture:** Add a diff→standards matcher to `apps/cli/src/lib/standards.ts` (beside `resolve_active_standards`) that enumerates the workspace's git repos, collects branch-changed paths, and `fnmatch`-matches them against each standard's `applies_to`. `apps/cli/src/commands/notes.ts::build_context` (already the `SessionStart` hook target) renders the matches as a block. No new hook, no new command, no new dependency.

**Tech Stack:** Node 20+, stdlib `subprocess` + `fnmatch`, `vitest` (run via `npx vitest run`), `pyyaml` (already used).

## Global Constraints

- Package is imported as `cli` (container dir `apps/cli/`). Tests live in `apps/cli/src/lib/__tests__/`, discovered by the vitest config in `apps/cli`.
- **Hook safety:** this code feeds `sandbox notes context`, a `SessionStart` hook that must never raise or hang. Every git call runs under `subprocess.run(..., timeout=_GIT_TIMEOUT)`; any git failure/timeout/OSError contributes nothing rather than raising. `commands/notes.ts::run()` already wraps `build_context` in a catch-all — do not remove it.
- **No new dependency.** Use stdlib `fnmatch` for glob matching. `# ponytail: fnmatch maps '*' and '**' both to '.*', so it matches across '/' — permissive in the direction we want; worst case = one extra one-liner. Swap to pathspec only if false positives get noisy.`
- Skill name for a domain = `cli.lib.skill_gen.skill_name_for(domain)` → `tr-<domain>-standard`.
- Universal base domain constant = `cli.lib.standards.UNIVERSAL_STANDARD` (`"comments"`); it has no meaningful `applies_to` — include it whenever *any* file changed.
- Base ref for branch scope = first of `origin/main`, `main` that resolves; if neither resolves, degrade to uncommitted-only.
- Spec: [docs/superpowers/specs/2026-07-18-context-compression-standards-reinjection-design.md](../specs/2026-07-18-context-compression-standards-reinjection-design.md).
- **Placement note (refines spec):** the matcher lives in `standards.ts`, not `lib/notes.ts` — it is standards resolution and belongs beside `resolve_active_standards`; keeps `notes.ts` pure note plumbing.

---

### Task 1: Git diff enumeration helpers

**Files:**
- Modify: `apps/cli/src/lib/standards.ts` (add module-level helpers + import `subprocess`)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `_repo_dirs(workspace: Path) -> list[Path]` — immediate subdirs of `workspace` containing a `.git` entry (dir or file), sorted; `[]` on any OSError.
  - `_changed_paths(repo: Path) -> list[str]` — repo-relative paths changed on this branch (branch-vs-base ∪ uncommitted); `[]` on any git failure.
  - `_GIT_TIMEOUT = 5`

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/__tests__/standards.test.ts`:

```node
import subprocess
from pathlib import Path
from cli.lib import standards


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "-C", str(repo), *args],
        check=True, capture_output=True, text=True,
    )


def _make_repo(repo: Path) -> None:
    """A repo on branch `feature` off `main`: base.txt committed on main,
    src/foo.service.ts committed on feature, src/bar.controller.ts untracked."""
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")
    (repo / "base.txt").write_text("base\n")
    _git(repo, "add", "base.txt")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "src").mkdir()
    (repo / "src" / "foo.service.ts").write_text("export {}\n")
    _git(repo, "add", "src/foo.service.ts")
    _git(repo, "commit", "-q", "-m", "feat")
    (repo / "src" / "bar.controller.ts").write_text("export {}\n")  # untracked


def test_repo_dirs_finds_git_children(tmp_path: Path) -> None:
    (tmp_path / "not-a-repo").mkdir()
    _make_repo(tmp_path / "econx")
    assert standards._repo_dirs(tmp_path) == [tmp_path / "econx"]


def test_changed_paths_unions_branch_and_uncommitted(tmp_path: Path) -> None:
    repo = tmp_path / "econx"
    _make_repo(repo)
    changed = set(standards._changed_paths(repo))
    assert "src/foo.service.ts" in changed      # committed on branch vs main
    assert "src/bar.controller.ts" in changed   # untracked
    assert "base.txt" not in changed            # in the merge-base


def test_changed_paths_no_base_ref_degrades_to_uncommitted(tmp_path: Path) -> None:
    repo = tmp_path / "solo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "trunk")  # no origin/main, no main
    (repo / "dirty.ts").write_text("x\n")    # untracked
    changed = set(standards._changed_paths(repo))
    assert changed == {"dirty.ts"}


def test_changed_paths_bad_repo_never_raises(tmp_path: Path) -> None:
    assert standards._changed_paths(tmp_path / "nonexistent") == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k "repo_dirs or changed_paths" -q`
Expected: FAIL — `AttributeError: module 'cli.lib.standards' has no attribute '_repo_dirs'`.

- [ ] **Step 3: Implement the helpers**

At the top of `apps/cli/src/lib/standards.ts`, add `import subprocess` next to the existing imports. Then add, below `UNIVERSAL_STANDARD`:

```node
_GIT_TIMEOUT = 5  # seconds; this feeds a SessionStart hook — never hang a launch


def _repo_dirs(workspace: Path) -> list[Path]:
    """Immediate subdirectories of *workspace* that are git repos/worktrees.

    Worktrees carry a `.git` file, standalone clones a `.git` dir — `.exists()`
    covers both. Never raises: an unreadable workspace yields no repos.
    """
    try:
        return sorted(
            child
            for child in workspace.iterdir()
            if child.is_dir() and (child / ".git").exists()
        )
    except OSError:
        return []


def _changed_paths(repo: Path) -> list[str]:
    """Repo-relative paths changed on this branch: branch-vs-base ∪ uncommitted.

    Best-effort and silent — any git failure, non-zero exit, or timeout
    contributes nothing rather than raising (this feeds a launch hook). Base
    ref is the first of origin/main, main that resolves; if neither does, the
    branch-scope diff is skipped and only uncommitted changes are reported.
    """
    def _git(*args: str) -> list[str]:
        try:
            proc = subprocess.run(
                ["git", "-C", str(repo), *args],
                capture_output=True, text=True, timeout=_GIT_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError):
            return []
        if proc.returncode != 0:
            return []
        return [line for line in proc.stdout.splitlines() if line]

    paths: set[str] = set()

    base = next(
        (b for b in ("origin/main", "main")
         if _git("rev-parse", "--verify", "--quiet", b)),
        None,
    )
    if base:
        merge_base = _git("merge-base", "HEAD", base)
        if merge_base:
            paths.update(_git("diff", "--name-only", f"{merge_base[0]}...HEAD"))

    # Uncommitted: porcelain lines are "XY <path>" (or "XY <old> -> <new>" on
    # rename); take the path column, unquote, keep the destination on renames.
    for line in _git("status", "--porcelain"):
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ")[-1]
        path = path.strip().strip('"')
        if path:
            paths.add(path)

    return sorted(paths)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k "repo_dirs or changed_paths" -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/standards.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "feat(jit): git diff enumeration helpers for standards re-injection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The diff→standards matcher

**Files:**
- Modify: `apps/cli/src/lib/standards.ts` (add `standards_matching_diff` + `import fnmatch`)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts`

**Interfaces:**
- Consumes: `_repo_dirs`, `_changed_paths` (Task 1); `load_standards_modules`, `UNIVERSAL_STANDARD` (existing).
- Produces: `standards_matching_diff(workspace: Path, modules: dict | None = None) -> list[tuple[str, str]]` — `(domain, summary)` for every standard whose `applies_to` matches a changed path, sorted by domain, with `comments` appended last whenever any file changed. `[]` when nothing changed or `modules` is empty.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/__tests__/standards.test.ts`:

```node
_FAKE_MODULES = {
    "service": {"applies_to": ["**/*.service.ts", "**/controllers/**"],
                "summary": "Service-boundary contract."},
    "ui": {"applies_to": ["**/*.tsx"], "summary": "UI standard."},
    "comments": {"applies_to": [], "summary": "Comments explain the why."},
}


def test_matching_diff_matches_globs_and_appends_comments(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(standards, "_repo_dirs", lambda ws: [tmp_path / "econx"])
    monkeypatch.setattr(standards, "_changed_paths", lambda repo: ["src/foo.service.ts"])
    result = standards.standards_matching_diff(tmp_path, modules=_FAKE_MODULES)
    assert result == [("service", "Service-boundary contract."),
                      ("comments", "Comments explain the why.")]  # comments last


def test_matching_diff_no_domain_match_still_includes_comments(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(standards, "_repo_dirs", lambda ws: [tmp_path / "econx"])
    monkeypatch.setattr(standards, "_changed_paths", lambda repo: ["README.md"])
    result = standards.standards_matching_diff(tmp_path, modules=_FAKE_MODULES)
    assert result == [("comments", "Comments explain the why.")]


def test_matching_diff_empty_when_nothing_changed(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(standards, "_repo_dirs", lambda ws: [tmp_path / "econx"])
    monkeypatch.setattr(standards, "_changed_paths", lambda repo: [])
    assert standards.standards_matching_diff(tmp_path, modules=_FAKE_MODULES) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k matching_diff -q`
Expected: FAIL — `AttributeError: ... has no attribute 'standards_matching_diff'`.

- [ ] **Step 3: Implement the matcher**

At the top of `apps/cli/src/lib/standards.ts`, add `from fnmatch import fnmatch`. Then add (below `_changed_paths`):

```node
def standards_matching_diff(
    workspace: Path,
    modules: dict[str, dict[str, Any]] | None = None,
) -> list[tuple[str, str]]:
    """(domain, summary) for every standard whose applies_to matches a file
    changed on this branch, plus the universal `comments` base whenever any
    file changed at all.

    Returns [] when nothing changed or no module resolves — the caller reads
    empty as "inject no block". Never raises: the git layer is best-effort and
    load_standards_modules() skips malformed modules.
    """
    if modules is None:
        modules = load_standards_modules()
    if not modules:
        return []

    changed: set[str] = set()
    for repo in _repo_dirs(workspace):
        changed.update(_changed_paths(repo))
    if not changed:
        return []

    matched: list[tuple[str, str]] = []
    for domain, meta in sorted(modules.items()):
        if domain == UNIVERSAL_STANDARD:
            continue
        globs = meta.get("applies_to") or []
        # ponytail: fnmatch maps '*' and '**' both to '.*', so it matches across
        # '/'; permissive in the direction we want. Worst case = one extra
        # one-liner. Swap to pathspec only if false positives get noisy.
        if any(fnmatch(path, glob) for path in changed for glob in globs):
            matched.append((domain, str(meta.get("summary", "")).strip()))

    universal = modules.get(UNIVERSAL_STANDARD)
    if universal is not None:
        matched.append((UNIVERSAL_STANDARD, str(universal.get("summary", "")).strip()))
    return matched
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k matching_diff -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/standards.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "feat(jit): standards_matching_diff — glob-match branch diff to standards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Render the block in `build_context`

**Files:**
- Modify: `apps/cli/src/commands/notes.ts` (`build_context` + new `_render_active_standards`, two new imports)
- Test: `apps/cli/src/lib/__tests__/notes.test.ts`

**Interfaces:**
- Consumes: `standards_matching_diff` (Task 2), `skill_gen.skill_name_for`, existing `latest_handoff` / `open_decisions` / `_render_note`.
- Produces: updated `build_context(workspace: Path) -> str` that appends the standards block when the matcher is non-empty; emits `""` only when there are no notes AND no matched standards.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/__tests__/notes.test.ts`:

```node
def test_build_context_appends_active_standards(tmp_path, monkeypatch) -> None:
    from cli.commands import notes as notes_cmd

    _write_note(notes_dir(tmp_path), "001-handoff-day-one.md", "handoff",
                body="Resume here.")
    monkeypatch.setattr(
        notes_cmd, "standards_matching_diff",
        lambda ws: [("service", "Service-boundary contract."),
                    ("comments", "Comments explain the why.")],
    )
    out = notes_cmd.build_context(tmp_path)
    assert "Resume here." in out                       # notes still render
    assert "Active standards" in out
    assert "`sb-service-standard` — Service-boundary contract." in out
    assert "`sb-comments-standard` — Comments explain the why." in out
    assert "Re-invoke the skill" in out


def test_build_context_standards_only_no_notes(tmp_path, monkeypatch) -> None:
    from cli.commands import notes as notes_cmd

    monkeypatch.setattr(
        notes_cmd, "standards_matching_diff",
        lambda ws: [("comments", "Comments explain the why.")],
    )
    out = notes_cmd.build_context(tmp_path)  # no notes on disk
    assert "`sb-comments-standard`" in out
    assert "Latest handoff" not in out


def test_build_context_empty_when_no_notes_and_no_standards(tmp_path, monkeypatch) -> None:
    from cli.commands import notes as notes_cmd

    monkeypatch.setattr(notes_cmd, "standards_matching_diff", lambda ws: [])
    assert notes_cmd.build_context(tmp_path) == ""
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -k build_context -q`
Expected: FAIL — `AttributeError: module 'cli.commands.notes' has no attribute 'standards_matching_diff'` (import not yet added).

- [ ] **Step 3: Implement the render + rewire `build_context`**

In `apps/cli/src/commands/notes.ts`, extend the standards import and add the skill-name import (near the existing `from cli.lib.standards import load_standards_modules`):

```node
from cli.lib.skill_gen import skill_name_for
from cli.lib.standards import load_standards_modules, standards_matching_diff
```

Add the renderer next to `_render_note`:

```node
def _render_active_standards(pairs: list[tuple[str, str]]) -> str:
    """Render the diff-scoped standards re-injection block."""
    lines = [
        "── Active standards (files changed on this branch match these) ──",
        "You loaded these standards earlier this session; compaction dropped the "
        "full rules. Re-invoke the skill to reload them before editing matching "
        "files again — CLAUDE.md's routing only re-triggers *before* a new edit, "
        "not mid-task.",
    ]
    for domain, summary in pairs:
        line = f"- `{skill_name_for(domain)}`"
        if summary:
            line += f" — {summary}"
        lines.append(line)
    return "\n".join(lines) + "\n"
```

Replace the body of `build_context` with:

```node
def build_context(workspace: Path) -> str:
    """Render the session-start notes + active-standards context; empty when neither exists."""
    handoff = latest_handoff(workspace)
    decisions = open_decisions(workspace)
    standards = standards_matching_diff(workspace)
    if handoff is None and not decisions and not standards:
        return ""

    sections: list[str] = []
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

    if standards:
        sections.append(_render_active_standards(standards))

    return "\n".join(sections)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -k build_context -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/notes.ts apps/cli/src/lib/__tests__/notes.test.ts
git commit -m "feat(jit): re-inject diff-scoped active standards on session start

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full-suite regression + spec docs

**Files:**
- Modify: `docs/jit-README.md` (notes-layer bullet — mention active-standards re-injection)

**Interfaces:** none (verification + docs).

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run apps/cli/src/lib/__tests__/ -q`
Expected: PASS — all existing tests plus the 10 new ones. Pay attention to `notes.test.ts` (build_context change) and `standards.test.ts`.

- [ ] **Step 2: Update the current-state index**

In `docs/jit-README.md`, in the "Where each piece lives (code)" list, extend the Notes-layer bullet to mention that `sandbox notes context` also re-injects diff-matched active standards' one-liners on session start (point at this plan's spec, don't copy detail — the README's own "point, never copy" rule).

Exact edit — replace the sub-bullet:

```
  context` / `graduate`), `docs/notes-conventions.md`; SessionStart hook via
  `apps/cli/src/lib/hooks_gen.ts`; teardown print via `apps/cli/src/commands/down.ts`
```

with:

```
  context` / `graduate`), `docs/notes-conventions.md`; SessionStart hook via
  `apps/cli/src/lib/hooks_gen.ts`; teardown print via `apps/cli/src/commands/down.ts`. `notes
  context` also re-injects diff-matched active standards' one-liners
  (`standards.standards_matching_diff`) so compaction-squashed standards get
  re-anchored — see specs/2026-07-18-context-compression-standards-reinjection-design.md.
```

- [ ] **Step 3: Commit**

```bash
git add docs/jit-README.md
git commit -m "docs(jit): note diff-scoped active-standards re-injection in current-state index

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Matcher (enumerate repos → branch diff ∪ uncommitted → fnmatch `applies_to` → include `comments`) → Tasks 1–2. ✓
- `origin/main` → `main` → uncommitted-only degradation → Task 1 `_changed_paths` + `test_changed_paths_no_base_ref_degrades_to_uncommitted`. ✓
- Render block + re-invoke directive in `build_context` → Task 3. ✓
- Self-scoping (empty on no-diff; standards-only when notes absent) → Task 3 tests. ✓
- Hook safety (never raise/hang; timeout) → Global Constraints + `_GIT_TIMEOUT` + defensive git wrapper; existing `run()` catch-all untouched. ✓
- Skip scratchpad/recitation; behavioral eval deferred → Non-goals in spec, not planned. ✓
- `skill_name_for` mapping → Task 3. ✓

**Placeholder scan:** none — every step carries full code/commands.

**Type consistency:** `standards_matching_diff(workspace, modules=None) -> list[tuple[str,str]]` defined in Task 2, consumed identically in Task 3 (monkeypatched with the same shape). `_repo_dirs`/`_changed_paths` signatures match between Task 1 definition and Task 2 monkeypatch. `skill_name_for(domain)` returns `tr-<domain>-standard` as used in Task 3 assertions.
