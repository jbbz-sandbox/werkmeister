# Authoring Pipeline (Decision-Note Graduation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `sb-review`'s decision notes into real `docs/standards/` content — a CLI that scaffolds placeholder-filled files/bullets (`sandbox notes graduate`, and `sandbox down`'s teardown prompt), and a new `sb-author` skill that fills the placeholders in.

**Architecture:** A new pure-mechanics module (`apps/cli/src/lib/graduate.ts`) does all file writing and validation with no prose judgment and no prompting. CLI-layer glue in `apps/cli/src/commands/notes.ts` resolves domain/kind (interactively or via flags) and calls it; `apps/cli/src/commands/down.ts` reuses that same glue. `apps/cli/src/lib/skill_gen.ts` gains a small check so an unfilled scaffold fails `sandbox skills check`. A new hand-authored `infra/skills/sb-author/SKILL.md` does the actual authoring (reads the note + code, writes prose) — picked up automatically by the existing glob-based skill projection, no generator change.

**Tech Stack:** Node 20+ (`cli` package); vitest via `npx vitest run` from the repo root; Markdown skill files.

## Global Constraints

- Branch: `multi-feature` (permanent; never merges to `main`).
- Commits: conventional commits, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (matching this workstream's existing commits).
- Test command (always from repo root): `npx vitest run apps/cli/src/lib/__tests__/<file> -q`.
- Spec: `docs/superpowers/specs/2026-07-12-authoring-pipeline-design.md` — v1 graduates into `api` only (the only domain with the `## Rules`/`## Don't`/`## Going deeper` shape today); no new domain creation; no PR-comment/incident capture; no auto-commit.
- Do NOT touch: `docs/standards/*` frontmatter shape, `apps/cli/src/lib/agent_gen.ts`, `infra/config/services.yaml`, the note `type` enum (`apps/cli/src/lib/notes.ts:NOTE_TYPES`).
- New skill file copies the voice/structure of `infra/skills/sb-review/SKILL.md` (frontmatter `name` + quoted `description`, numbered steps).

---

### Task 1: `apps/cli/src/lib/graduate.ts` — pure mechanics

**Files:**
- Create: `apps/cli/src/lib/graduate.ts`
- Test: `apps/cli/src/lib/__tests__/graduate.test.ts`

**Interfaces:**
- Consumes: `cli.lib.config.get_sandbox_root`, `cli.lib.standards.load_standards_modules`. Reads note dicts shaped like `cli.lib.notes.parse_note()`'s return value (`{path, number, type, slug, frontmatter, body}`).
- Produces: `GraduationError` (exception), `KINDS` (tuple), `eligible_domains(modules) -> list[str]`, `match_domains_for_refs(refs, modules, candidates=None) -> list[str]`, `graduate_note(workspace_root, note, *, domain, kind, slug=None, standards_dir=None) -> dict` returning `{"standard_path": Path, "scaffold_path": Path, "note_path": Path, "graduated_to": str}`. Consumed by Task 4 (`apps/cli/src/commands/notes.ts`).

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/lib/__tests__/graduate.test.ts`:

```node
"""Tests for cli.lib.graduate — decision-note -> docs/standards/ graduation
(2026-07-12-authoring-pipeline-design.md). Pure mechanics: no prompting, no
prose judgment.
"""

from __future__ import annotations

from pathlib import Path

import vitest
import yaml

from cli.lib.graduate import (
    GraduationError,
    eligible_domains,
    graduate_note,
    match_domains_for_refs,
)
from cli.lib.notes import parse_note


def _write_note(directory: Path, name: str, *, refs: list[str] | None = None,
                 status: str = "open", body: str = "Body.") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    refs_yaml = yaml.safe_dump(refs or [], default_flow_style=True).strip()
    path.write_text(
        f"---\ntype: decision\nphase: review\nauthor: main\nrefs: {refs_yaml}\n"
        f"status: {status}\n---\n\n{body}\n"
    )
    return path


@vitest.fixture
def standards_dir(tmp_path: Path) -> Path:
    """One eligible domain (api, Rules/Don't/Going-deeper shape) and one
    ineligible domain (graphql, pre-migration shape) — mirrors the real repo."""
    d = tmp_path / "standards"
    (d / "api").mkdir(parents=True)
    (d / "api" / "STANDARD.md").write_text(
        "---\n"
        "domain: api\n"
        'applies_to: ["**/controllers/**", "**/*.controller.ts"]\n'
        "phase: [implement, review]\n"
        "summary: API standard.\n"
        "---\n\n"
        "# API standard\n\n"
        "## Rules\n\n"
        "- **Resource naming** — plural nouns.\n\n"
        "## Don't\n\n"
        "- Don't leak stack traces — [references/ap-leaky-errors.md](references/ap-leaky-errors.md)\n\n"
        "## Going deeper\n"
        "| When you're doing | Read |\n|---|---|\n"
        "| writing catch blocks | [references/ap-leaky-errors.md](references/ap-leaky-errors.md) |\n"
    )
    refs = d / "api" / "references"
    refs.mkdir()
    (refs / "ap-leaky-errors.md").write_text(
        "---\nkind: anti-pattern\n---\n\n# Leaky errors\n\nWar story.\n"
    )
    (d / "graphql").mkdir(parents=True)
    (d / "graphql" / "STANDARD.md").write_text(
        "---\n"
        "domain: graphql\n"
        'applies_to: ["**/*.graphql"]\n'
        "phase: [implement, review]\n"
        "summary: GraphQL standard.\n"
        "---\n\n"
        "# GraphQL standard\n\n## Idioms\n\nPre-migration shape, no Rules/Don't.\n"
    )
    return d


def test_eligible_domains_excludes_pre_migration_shape(standards_dir: Path) -> None:
    from cli.lib.standards import load_standards_modules

    modules = load_standards_modules(standards_dir)
    assert eligible_domains(modules) == ["api"]


def test_match_domains_for_refs_by_glob(standards_dir: Path) -> None:
    from cli.lib.standards import load_standards_modules

    modules = load_standards_modules(standards_dir)
    matches = match_domains_for_refs(
        ["apps/sb-web-api/src/products.controller.ts"], modules, candidates=["api"]
    )
    assert matches == ["api"]


def test_match_domains_for_refs_by_exact_key(standards_dir: Path) -> None:
    from cli.lib.standards import load_standards_modules

    modules = load_standards_modules(standards_dir)
    assert match_domains_for_refs(["api"], modules) == ["api"]


def test_match_domains_for_refs_no_match(standards_dir: Path) -> None:
    from cli.lib.standards import load_standards_modules

    modules = load_standards_modules(standards_dir)
    assert match_domains_for_refs(["totally/unrelated.ts"], modules) == []


def test_graduate_rule_inserts_placeholder_bullet_and_marks_note(
    tmp_path: Path, standards_dir: Path
) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "003-decision-pagination.md",
                             refs=["api"])
    note = parse_note(note_path)

    result = graduate_note(
        tmp_path, note, domain="api", kind="rule", standards_dir=standards_dir
    )

    standard = (standards_dir / "api" / "STANDARD.md").read_text()
    assert "TODO(graduate): fill from note 003" in standard
    assert ".sandbox/notes/003-decision-pagination.md" in standard
    # Inserted at the end of ## Rules, before ## Don't
    assert standard.index("TODO(graduate)") < standard.index("## Don't")
    assert result["scaffold_path"] == standards_dir / "api" / "STANDARD.md"

    reparsed = parse_note(note_path)
    assert reparsed["frontmatter"]["status"] == "graduated"
    assert reparsed["frontmatter"]["graduated_to"] == "api/STANDARD.md"
    assert reparsed["body"] == note["body"]  # body untouched


def test_graduate_example_scaffolds_reference_and_going_deeper_row(
    tmp_path: Path, standards_dir: Path
) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "004-decision-cursor.md",
                             refs=["api"])
    note = parse_note(note_path)

    result = graduate_note(
        tmp_path, note, domain="api", kind="example", standards_dir=standards_dir
    )

    scaffold = result["scaffold_path"]
    assert scaffold == standards_dir / "api" / "references" / "cursor.md"
    content = scaffold.read_text()
    assert content.startswith("---\nkind: example\ncanonical: TODO\n---")
    assert "TODO(graduate): fill from note 004" in content

    standard = (standards_dir / "api" / "STANDARD.md").read_text()
    assert "[references/cursor.md](references/cursor.md)" in standard

    reparsed = parse_note(note_path)
    assert reparsed["frontmatter"]["graduated_to"] == "api/references/cursor.md"


def test_graduate_anti_pattern_wires_dont_bullet_and_going_deeper(
    tmp_path: Path, standards_dir: Path
) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "005-decision-untyped-body.md",
                             refs=["api"])
    note = parse_note(note_path)

    result = graduate_note(
        tmp_path, note, domain="api", kind="anti-pattern", standards_dir=standards_dir
    )

    assert result["scaffold_path"].name == "ap-untyped-body.md"
    standard = (standards_dir / "api" / "STANDARD.md").read_text()
    assert "[references/ap-untyped-body.md](references/ap-untyped-body.md)" in standard
    # Both the Don't bullet and the Going-deeper row were added — each line
    # mentions the filename twice (link text + URL), so 2 lines * 2 = 4.
    assert standard.count("references/ap-untyped-body.md") == 4


def test_graduate_rejects_non_decision_note(tmp_path: Path, standards_dir: Path) -> None:
    directory = tmp_path / ".sandbox" / "notes"
    directory.mkdir(parents=True)
    path = directory / "001-finding-slow-query.md"
    path.write_text("---\ntype: finding\nphase: review\nauthor: main\nrefs: []\n"
                     "status: open\n---\n\nBody.\n")
    note = parse_note(path)
    with vitest.raises(GraduationError, match="not a decision note"):
        graduate_note(tmp_path, note, domain="api", kind="rule", standards_dir=standards_dir)


def test_graduate_rejects_already_graduated_note(tmp_path: Path, standards_dir: Path) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "002-decision-old.md",
                             status="graduated")
    note = parse_note(note_path)
    with vitest.raises(GraduationError, match="already graduated"):
        graduate_note(tmp_path, note, domain="api", kind="rule", standards_dir=standards_dir)


def test_graduate_rejects_ineligible_domain(tmp_path: Path, standards_dir: Path) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "006-decision-fragment.md",
                             refs=["graphql"])
    note = parse_note(note_path)
    with vitest.raises(GraduationError, match="Rules/Don't/Going-deeper"):
        graduate_note(tmp_path, note, domain="graphql", kind="rule", standards_dir=standards_dir)


def test_graduate_rejects_unknown_domain(tmp_path: Path, standards_dir: Path) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "007-decision-x.md")
    note = parse_note(note_path)
    with vitest.raises(GraduationError, match="no docs/standards/data"):
        graduate_note(tmp_path, note, domain="data", kind="rule", standards_dir=standards_dir)


def test_graduate_rejects_unknown_kind(tmp_path: Path, standards_dir: Path) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "008-decision-y.md")
    note = parse_note(note_path)
    with vitest.raises(GraduationError, match="unknown kind"):
        graduate_note(tmp_path, note, domain="api", kind="nonsense", standards_dir=standards_dir)


def test_graduate_rejects_slug_collision(tmp_path: Path, standards_dir: Path) -> None:
    (standards_dir / "api" / "references" / "cursor.md").write_text(
        "---\nkind: example\n---\n\nAlready here.\n"
    )
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "009-decision-cursor.md")
    note = parse_note(note_path)
    with vitest.raises(GraduationError, match="already exists"):
        graduate_note(tmp_path, note, domain="api", kind="example", standards_dir=standards_dir)


def test_graduate_slug_override(tmp_path: Path, standards_dir: Path) -> None:
    note_path = _write_note(tmp_path / ".sandbox" / "notes", "010-decision-cursor.md")
    note = parse_note(note_path)
    result = graduate_note(
        tmp_path, note, domain="api", kind="example", slug="custom-slug",
        standards_dir=standards_dir,
    )
    assert result["scaffold_path"].name == "custom-slug.md"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run apps/cli/src/lib/__tests__/graduate.test.ts -q
```

Expected: FAIL — `ModuleNotFoundError: No module named 'cli.lib.graduate'`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/lib/graduate.ts`:

```node
"""
Decision-note → docs/standards/ graduation
(2026-07-12-authoring-pipeline-design.md).

Pure mechanics: scaffold placeholder content and wire the structural links a
domain's STANDARD.md needs. No prose judgment (that's `sb-author`, a skill)
and no interactive prompting (that's the CLI layer in `cli.commands.notes`).
"""

from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Any

import yaml

from cli.lib.config import get_sandbox_root

KINDS = ("rule", "example", "anti-pattern")

_GOING_DEEPER_HEADER = "## Going deeper\n| When you're doing | Read |\n|---|---|\n"


class GraduationError(ValueError):
    """Raised for any graduate_note() precondition failure."""


def _insert_at_section_end(
    body: str, marker: str, line: str, header_if_missing: str | None = None
) -> str:
    """Insert *line* as the last content line of the ``marker`` (``"## X"``)
    section, right before the next ``## `` heading or EOF.

    If the section doesn't exist: append a new section with *header_if_missing*
    first (used for ``## Going deeper``, which the content model says is added
    "when they have references" — i.e. lazily, by this function). If
    *header_if_missing* is None, the section is required to already exist
    (``## Rules``/``## Don't`` on an eligible domain always do) and its
    absence raises.
    """
    if marker not in body:
        if header_if_missing is None:
            raise GraduationError(f"STANDARD.md has no '{marker}' section")
        return body.rstrip("\n") + "\n\n" + header_if_missing + line + "\n"
    idx = body.index(marker)
    rest = body[idx:]
    next_rel = rest.find("\n## ", 1)
    boundary = idx + next_rel if next_rel != -1 else len(body)
    head = body[:boundary].rstrip("\n")
    tail = body[boundary:]
    return f"{head}\n{line}\n" + (tail.lstrip("\n") if tail else "")


def eligible_domains(modules: dict[str, dict[str, Any]]) -> list[str]:
    """Domains already in the Rules/Don't/Going-deeper shape (spec §2.3/§4).

    Today that's `api` only — graphql/ui/data/comments were directory-
    migrated with content unchanged and still carry their pre-migration
    sections.
    """
    result = []
    for domain, meta in modules.items():
        body = Path(meta["path"]).read_text()
        if "## Rules" in body and "## Don't" in body:
            result.append(domain)
    return sorted(result)


def match_domains_for_refs(
    refs: list[str],
    modules: dict[str, dict[str, Any]],
    candidates: list[str] | None = None,
) -> list[str]:
    """Match a decision note's `refs` (file paths or free-text domain
    mentions — sb-review's capture template doesn't guarantee domain keys)
    against each candidate domain's `applies_to` glob list, or the domain
    key itself.
    """
    pool = candidates if candidates is not None else list(modules)
    matched: set[str] = set()
    for ref in refs:
        for domain in pool:
            if ref == domain:
                matched.add(domain)
                continue
            for pattern in modules[domain].get("applies_to") or []:
                if fnmatch.fnmatch(ref, pattern):
                    matched.add(domain)
                    break
    return sorted(matched)


def _update_note_status(note_path: Path, **fields: str) -> None:
    """Rewrite frontmatter fields on a note file; body is preserved exactly."""
    text = note_path.read_text()
    parts = text.split("---", 2)
    frontmatter = yaml.safe_load(parts[1]) or {}
    frontmatter.update(fields)
    new_fm = yaml.safe_dump(frontmatter, default_flow_style=False, sort_keys=False)
    note_path.write_text(f"---\n{new_fm}---{parts[2]}")


def graduate_note(
    workspace_root: Path,
    note: dict[str, Any],
    *,
    domain: str,
    kind: str,
    slug: str | None = None,
    standards_dir: Path | None = None,
) -> dict[str, Any]:
    """Scaffold *note* (a `cli.lib.notes.parse_note()` dict) into *domain*.

    `domain` and `kind` must already be resolved by the caller — this
    function only validates and writes; it never prompts.
    """
    from cli.lib.standards import load_standards_modules  # local: avoid import cycle

    if note["type"] != "decision":
        raise GraduationError(f"note {note['path'].name} is not a decision note")
    status = note["frontmatter"].get("status")
    if status in ("graduated", "superseded"):
        raise GraduationError(f"note {note['path'].name} is already {status}")
    if kind not in KINDS:
        raise GraduationError(f"unknown kind {kind!r} (expected one of {KINDS})")

    if standards_dir is None:
        standards_dir = get_sandbox_root() / "docs" / "standards"
    modules = load_standards_modules(standards_dir)
    if domain not in modules:
        raise GraduationError(f"no docs/standards/{domain} module")
    if domain not in eligible_domains(modules):
        raise GraduationError(
            f"'{domain}' hasn't been migrated to the Rules/Don't/Going-deeper "
            f"shape yet — that's separate content work, not this pipeline's job"
        )

    meta = modules[domain]
    standard_path = Path(meta["path"])
    body = standard_path.read_text()

    resolved_slug = slug or note["slug"]
    note_ref = f".sandbox/notes/{note['path'].name}"
    marker = f"<!-- TODO(graduate): fill from note {note['number']:03d}, see {note_ref} -->"

    if kind == "rule":
        bullet = f"- **TODO(graduate)** — {marker}"
        body = _insert_at_section_end(body, "## Rules", bullet)
        standard_path.write_text(body)
        scaffold_path = standard_path
    else:
        prefix = "ap-" if kind == "anti-pattern" else ""
        filename = f"{prefix}{resolved_slug}.md"
        refs_dir = standard_path.parent / "references"
        refs_dir.mkdir(exist_ok=True)
        scaffold_path = refs_dir / filename
        if scaffold_path.exists():
            raise GraduationError(f"{scaffold_path} already exists")

        if kind == "example":
            scaffold_path.write_text(
                "---\n"
                "kind: example\n"
                "canonical: TODO\n"
                "---\n\n"
                "# TODO: title\n\n"
                "## The load-bearing part\n\n"
                f"{marker}\n"
            )
        else:  # anti-pattern
            scaffold_path.write_text(
                "---\n"
                "kind: anti-pattern\n"
                "---\n\n"
                "# TODO: title\n\n"
                "## What it looks like\n\n"
                f"{marker}\n\n"
                "## Why it's wrong\n\n"
                f"{marker}\n\n"
                "## The fix\n\n"
                f"{marker}\n"
            )
            dont_bullet = f"- Don't TODO(graduate) — [references/{filename}](references/{filename})"
            body = _insert_at_section_end(body, "## Don't", dont_bullet)

        row = f"| TODO(graduate) | [references/{filename}](references/{filename}) |"
        body = _insert_at_section_end(
            body, "## Going deeper", row, header_if_missing=_GOING_DEEPER_HEADER
        )
        standard_path.write_text(body)

    graduated_to = str(scaffold_path.relative_to(standards_dir))
    _update_note_status(note["path"], status="graduated", graduated_to=graduated_to)

    return {
        "standard_path": standard_path,
        "scaffold_path": scaffold_path,
        "note_path": note["path"],
        "graduated_to": graduated_to,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run apps/cli/src/lib/__tests__/graduate.test.ts -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/graduate.ts apps/cli/src/lib/__tests__/graduate.test.ts
git commit -m "feat(sandbox-cli): graduate_note — decision-note to standards scaffolding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `list_notes()`/`open_decisions()` stop resurfacing graduated notes

**Files:**
- Modify: `apps/cli/src/lib/notes.ts:104-106`
- Test: `apps/cli/src/lib/__tests__/notes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no interface change — `list_notes()`/`open_decisions()` keep the same signature; only which notes they return changes. Task 4/5 rely on a graduated note no longer appearing in `open_decisions()`.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/__tests__/notes.test.ts`, right after `test_list_notes_skips_superseded_by_default`:

```node
def test_list_notes_skips_graduated_by_default(tmp_path: Path) -> None:
    workspace = tmp_path
    directory = notes_dir(workspace)
    _write_note(directory, "001-decision-graduated.md", "decision", status="graduated")
    _write_note(directory, "002-finding-open.md", "finding")

    visible = list_notes(workspace)
    assert [n["number"] for n in visible] == [2]

    everything = list_notes(workspace, include_superseded=True)
    assert [n["number"] for n in everything] == [1, 2]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run apps/cli/src/lib/__tests__/notes.test.ts::test_list_notes_skips_graduated_by_default -q
```

Expected: FAIL — the graduated note is still returned.

- [ ] **Step 3: Implement**

In `apps/cli/src/lib/notes.ts`, change:

```node
    if not include_superseded:
        notes = [n for n in notes if n["frontmatter"].get("status") != "superseded"]
    return notes
```

to:

```node
    if not include_superseded:
        notes = [
            n for n in notes
            if n["frontmatter"].get("status") not in ("superseded", "graduated")
        ]
    return notes
```

(The `include_superseded` parameter keeps its name — it's the existing "show everything" escape hatch used by tests; it now also un-hides graduated notes, matching the docstring's intent of showing every note regardless of terminal status.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -q
```

Expected: all pass, including the new test.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/notes.ts apps/cli/src/lib/__tests__/notes.test.ts
git commit -m "fix(sandbox-cli): hide graduated notes from list_notes/open_decisions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `sandbox skills check` fails on unfilled scaffolds

**Files:**
- Modify: `apps/cli/src/lib/skill_gen.ts:198-229` (`validate_module_references`)
- Test: `apps/cli/src/lib/__tests__/skill_gen.test.ts`

**Interfaces:**
- Consumes: nothing new (`_module_body`, `_parse_frontmatter` already imported/defined in this file).
- Produces: `validate_module_references()` keeps its signature and return type (`list[str]`); it now also flags lingering `TODO(graduate)` markers and placeholder `canonical: TODO` — consumed unchanged by `apps/cli/src/commands/skills.ts`'s `sandbox skills check`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/lib/__tests__/skill_gen.test.ts`, after `test_validate_flags_ap_file_without_inline_dont_line`:

```node
def test_validate_flags_unfilled_todo_marker_in_standard_md(dir_standards: Path):
    from cli.lib.standards import load_standards_modules

    std = dir_standards / "api" / "STANDARD.md"
    std.write_text(std.read_text() + "\n- **TODO** — <!-- TODO(graduate): fill from note 003 -->\n")
    errors = validate_module_references(load_standards_modules(dir_standards))
    assert errors == [
        "docs/standards/api: STANDARD.md has an unfilled TODO(graduate) marker "
        "— run sb-author before committing"
    ]


def test_validate_flags_unfilled_todo_marker_in_reference(dir_standards: Path):
    from cli.lib.standards import load_standards_modules

    ref = dir_standards / "api" / "references" / "pagination.md"
    ref.write_text(ref.read_text() + "\n<!-- TODO(graduate): fill from note 004 -->\n")
    errors = validate_module_references(load_standards_modules(dir_standards))
    assert errors == [
        "docs/standards/api: references/pagination.md has an unfilled "
        "TODO(graduate) marker — run sb-author before committing"
    ]


def test_validate_flags_placeholder_canonical(dir_standards: Path):
    from cli.lib.standards import load_standards_modules

    ref = dir_standards / "api" / "references" / "pagination.md"
    ref.write_text(ref.read_text().replace(
        "canonical: comx:apps/sb-web-api/src/app/products/products.controller.ts",
        "canonical: TODO",
    ))
    errors = validate_module_references(load_standards_modules(dir_standards))
    assert errors == [
        "docs/standards/api: references/pagination.md has a placeholder "
        "canonical: TODO — fill in the real repo:path"
    ]


def test_validate_passes_on_well_formed_module_still(dir_standards: Path):
    # regression: the marker checks must not false-positive on real content
    from cli.lib.standards import load_standards_modules

    assert validate_module_references(load_standards_modules(dir_standards)) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts -k todo_marker -q
npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts -k placeholder_canonical -q
```

Expected: both FAIL (`assert [] == [...]` — no errors reported yet).

- [ ] **Step 3: Implement**

In `apps/cli/src/lib/skill_gen.ts`, replace the body of `validate_module_references`'s loop:

```node
    for domain, meta in sorted(modules.items()):
        refs_dir = meta.get("references_dir")
        if not refs_dir:
            continue
        body = _module_body(meta["path"])
        for ref in sorted(Path(refs_dir).glob("*.md")):
            link = f"(references/{ref.name})"
            if link not in body:
                errors.append(
                    f"docs/standards/{domain}: references/{ref.name} "
                    f"is not linked from STANDARD.md"
                )
            elif ref.name.startswith("ap-") and not re.search(
                rf"^\s*[-*] .*\(references/{re.escape(ref.name)}\)",
                body,
                re.MULTILINE,
            ):
                errors.append(
                    f"docs/standards/{domain}: references/{ref.name} needs "
                    f"an inline don't-line bullet linking to it"
                )
    return errors
```

with:

```node
    for domain, meta in sorted(modules.items()):
        body = _module_body(meta["path"])
        if "TODO(graduate)" in body:
            errors.append(
                f"docs/standards/{domain}: STANDARD.md has an unfilled "
                f"TODO(graduate) marker — run sb-author before committing"
            )
        refs_dir = meta.get("references_dir")
        if not refs_dir:
            continue
        for ref in sorted(Path(refs_dir).glob("*.md")):
            ref_body = _module_body(ref)
            if "TODO(graduate)" in ref_body:
                errors.append(
                    f"docs/standards/{domain}: references/{ref.name} has an "
                    f"unfilled TODO(graduate) marker — run sb-author before committing"
                )
            canonical = str(_parse_frontmatter(ref).get("canonical") or "")
            if canonical == "TODO":
                errors.append(
                    f"docs/standards/{domain}: references/{ref.name} has a "
                    f"placeholder canonical: TODO — fill in the real repo:path"
                )
            link = f"(references/{ref.name})"
            if link not in body:
                errors.append(
                    f"docs/standards/{domain}: references/{ref.name} "
                    f"is not linked from STANDARD.md"
                )
            elif ref.name.startswith("ap-") and not re.search(
                rf"^\s*[-*] .*\(references/{re.escape(ref.name)}\)",
                body,
                re.MULTILINE,
            ):
                errors.append(
                    f"docs/standards/{domain}: references/{ref.name} needs "
                    f"an inline don't-line bullet linking to it"
                )
    return errors
```

(The `body = _module_body(meta["path"])` read moves above the `references_dir` early-`continue` so a domain that only received a `rule`-kind scaffold — no new reference file — still gets its `STANDARD.md` TODO marker checked.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/skill_gen.ts apps/cli/src/lib/__tests__/skill_gen.test.ts
git commit -m "feat(sandbox-cli): sandbox skills check fails on unfilled graduation scaffolds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `sandbox notes graduate` command

**Files:**
- Modify: `apps/cli/src/commands/notes.ts`
- Modify: `apps/cli/src/main.ts:327-338` (`p_notes` parser)
- Test: `apps/cli/src/lib/__tests__/notes.test.ts`

**Interfaces:**
- Consumes: `cli.lib.graduate.{graduate_note, eligible_domains, match_domains_for_refs, GraduationError}` (Task 1), `cli.lib.notes.open_decisions` (existing), `cli.lib.standards.load_standards_modules` (existing), `cli.lib.config.{Colors, error, info, success}` (existing).
- Produces: `graduate_one(workspace, note, *, domain, kind, slug) -> dict` in `cli.commands.notes` — consumed by Task 5 (`down.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/lib/__tests__/notes.test.ts`, after the existing "sandbox down printing" section (before the `init_workspace acceptance` section):

```node
# ---------------------------------------------------------------------------
# sandbox notes graduate (2026-07-12-authoring-pipeline-design.md)
# ---------------------------------------------------------------------------


@vitest.fixture
def api_standards_dir(tmp_path: Path) -> Path:
    d = tmp_path / "standards"
    (d / "api").mkdir(parents=True)
    (d / "api" / "STANDARD.md").write_text(
        "---\ndomain: api\napplies_to: [\"**/controllers/**\"]\n"
        "phase: [implement, review]\nsummary: API standard.\n---\n\n"
        "# API standard\n\n## Rules\n\n- **X** — Y.\n\n## Don't\n\n"
        "- Don't Z — [references/ap-a.md](references/ap-a.md)\n\n"
        "## Going deeper\n| When you're doing | Read |\n|---|---|\n"
        "| a | [references/ap-a.md](references/ap-a.md) |\n"
    )
    refs = d / "api" / "references"
    refs.mkdir()
    (refs / "ap-a.md").write_text("---\nkind: anti-pattern\n---\n\nWar story.\n")
    return d


def _namespace(action: str, note_num=None, domain=None, kind=None, slug=None):
    return argparse.Namespace(action=action, note_num=note_num, domain=domain,
                              kind=kind, slug=slug)


def test_graduate_one_scaffolds_with_explicit_domain_and_kind(
    tmp_path: Path, api_standards_dir: Path, monkeypatch
) -> None:
    from cli.commands.notes import graduate_one
    from cli.lib.standards import load_standards_modules

    monkeypatch.setattr("cli.commands.notes.load_standards_modules",
                         lambda: load_standards_modules(api_standards_dir))
    _write_note(notes_dir(tmp_path), "003-decision-pagination.md", "decision", body="We picked cursor pagination.")
    note = parse_note(notes_dir(tmp_path) / "003-decision-pagination.md")

    result = graduate_one(tmp_path, note, domain="api", kind="rule", slug=None)
    assert result["graduated_to"] == "api/STANDARD.md"


def test_run_graduate_non_interactive_requires_flags(
    tmp_path: Path, api_standards_dir: Path, monkeypatch, capsys
) -> None:
    from cli.commands import notes as notes_cmd
    from cli.lib.standards import load_standards_modules

    monkeypatch.setattr(notes_cmd, "load_standards_modules",
                         lambda: load_standards_modules(api_standards_dir))
    monkeypatch.setattr(notes_cmd, "find_workspace_root", lambda start: tmp_path)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    _write_note(notes_dir(tmp_path), "003-decision-pagination.md", "decision")

    with vitest.raises(SystemExit):
        notes_cmd.run(_namespace("graduate", note_num=3))
    out = capsys.readouterr().out
    assert "domain" in out


def test_run_graduate_end_to_end_with_flags(
    tmp_path: Path, api_standards_dir: Path, monkeypatch, capsys
) -> None:
    from cli.commands import notes as notes_cmd
    from cli.lib.notes import open_decisions
    from cli.lib.standards import load_standards_modules

    monkeypatch.setattr(notes_cmd, "load_standards_modules",
                         lambda: load_standards_modules(api_standards_dir))
    monkeypatch.setattr(notes_cmd, "find_workspace_root", lambda start: tmp_path)
    _write_note(notes_dir(tmp_path), "003-decision-pagination.md", "decision")

    notes_cmd.run(_namespace("graduate", note_num=3, domain="api", kind="rule"))

    out = capsys.readouterr().out
    assert "sb-author" in out
    assert open_decisions(tmp_path) == []  # graduated notes stop resurfacing


def test_run_graduate_unknown_note_number_errors(
    tmp_path: Path, api_standards_dir: Path, monkeypatch
) -> None:
    from cli.commands import notes as notes_cmd

    monkeypatch.setattr(notes_cmd, "find_workspace_root", lambda start: tmp_path)
    _write_note(notes_dir(tmp_path), "003-decision-pagination.md", "decision")

    with vitest.raises(SystemExit):
        notes_cmd.run(_namespace("graduate", note_num=999, domain="api", kind="rule"))


def test_run_graduate_no_open_decisions_is_a_no_op(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    from cli.commands import notes as notes_cmd

    monkeypatch.setattr(notes_cmd, "find_workspace_root", lambda start: tmp_path)
    notes_cmd.run(_namespace("graduate"))
    assert "No open decision notes" in capsys.readouterr().out
```

No import changes needed: `notes.test.ts` already imports `argparse`, `vitest`, `notes_dir`, and `parse_note` at the top of the file (used by earlier tests in the same file).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -k graduate -q
```

Expected: FAIL — `graduate_one` doesn't exist yet, `action` choices don't include `"graduate"`.

- [ ] **Step 3: Implement — `apps/cli/src/commands/notes.ts`**

Rewrite `apps/cli/src/commands/notes.ts` in full:

```node
"""
sandbox notes <context|graduate>

`context`: print the workspace's notes context for injection into a fresh
Claude Code window — the SessionStart hook target
(jit-notes-and-handoffs-spec.md §4.5). Output is plain text on stdout, hook-
safe (never raises, always exits 0).

`graduate`: scaffold an open `decision` note into `docs/standards/`
(2026-07-12-authoring-pipeline-design.md). Mechanical scaffolding is
`cli.lib.graduate.graduate_note`; this module resolves domain/kind
(interactively at a TTY, or via `--domain`/`--kind` flags otherwise) and is
reused by `sandbox down`'s teardown prompt (`cli.commands.down`).
"""

from __future__ import annotations

import sys
from pathlib import Path

from cli.lib.config import Colors, error, info, success
from cli.lib.graduate import (
    GraduationError,
    eligible_domains,
    graduate_note,
    match_domains_for_refs,
)
from cli.lib.notes import latest_handoff, open_decisions
from cli.lib.standards import load_standards_modules

# Per-note body cap. The hook harness truncates combined output at 10k chars;
# staying under it ourselves keeps the pointer lines from being cut off.
_BODY_CHAR_CAP = 3500


def find_workspace_root(start: Path) -> Path | None:
    """Walk up from *start* to the nearest directory containing `.sandbox/`.

    Sessions launch from the workspace root or inside one of its repo
    worktrees; either way the workspace is the closest ancestor with a
    `.sandbox` directory.
    """
    for directory in [start, *start.parents]:
        if (directory / ".sandbox").is_dir():
            return directory
    return None


def _render_note(header: str, note: dict, workspace: Path) -> str:
    rel = note["path"].relative_to(workspace)
    body = note["body"].strip()
    if len(body) > _BODY_CHAR_CAP:
        body = body[:_BODY_CHAR_CAP] + "\n…(truncated — read the full note)"
    return f"── {header}: {rel} ──\n{body}\n"

def build_context(workspace: Path) -> str:
    """Render the session-start notes context; empty string when there are none."""
    handoff = latest_handoff(workspace)
    decisions = open_decisions(workspace)
    if handoff is None and not decisions:
        return ""

    sections = [
        "Workspace notes exist in .sandbox/notes/ — working state that survives "
        "sessions and compaction. `decision` notes are binding: they override "
        "task-level instincts; if one conflicts with the task as given, raise it "
        "to the user. Read relevant `finding`/`attempt` notes before "
        "re-researching or re-trying an approach.\n",
    ]
    if handoff is not None:
        sections.append(_render_note("Latest handoff", handoff, workspace))
    sections.extend(_render_note("Open decision", d, workspace) for d in decisions)
    return "\n".join(sections)


# ---------------------------------------------------------------------------
# graduate
# ---------------------------------------------------------------------------


def _resolve_domain(note: dict, modules: dict, domain: str | None) -> str:
    eligible = eligible_domains(modules)
    if domain:
        if domain not in eligible:
            raise GraduationError(
                f"'{domain}' is not an eligible domain (eligible: {', '.join(eligible)})"
            )
        return domain

    refs = note["frontmatter"].get("refs") or []
    matches = match_domains_for_refs(refs, modules, candidates=eligible)
    if len(matches) == 1:
        return matches[0]

    if not sys.stdin.isatty():
        raise GraduationError(
            f"ambiguous or unmatched domain for note refs {refs!r} — pass --domain "
            f"(eligible: {', '.join(eligible)})"
        )
    print(f"Which domain? [{', '.join(eligible)}]")
    choice = input("> ").strip()
    if choice not in eligible:
        raise GraduationError(f"'{choice}' is not an eligible domain")
    return choice


def _resolve_kind(kind: str | None) -> str:
    from cli.lib.graduate import KINDS

    if kind:
        return kind
    if not sys.stdin.isatty():
        raise GraduationError(f"--kind required (expected one of {KINDS})")
    choice = input(f"Kind? [{'/'.join(KINDS)}] > ").strip()
    if choice not in KINDS:
        raise GraduationError(f"'{choice}' is not a valid kind (expected one of {KINDS})")
    return choice


def graduate_one(
    workspace: Path, note: dict, *, domain: str | None, kind: str | None, slug: str | None
) -> dict:
    """Resolve domain/kind (interactively or via already-given values) and
    graduate *note*. Raises GraduationError on any failure — never prompts
    when a value is already given.
    """
    modules = load_standards_modules()
    resolved_domain = _resolve_domain(note, modules, domain)
    resolved_kind = _resolve_kind(kind)
    return graduate_note(workspace, note, domain=resolved_domain, kind=resolved_kind, slug=slug)


def _run_graduate(args) -> None:
    workspace = find_workspace_root(Path.cwd())
    if workspace is None:
        error("Not inside a sandbox workspace (no .sandbox/ directory found above CWD).")
        sys.exit(1)

    decisions = open_decisions(workspace)
    if not decisions:
        info("No open decision notes to graduate.")
        return

    note_num = args.note_num
    if note_num is None:
        if not sys.stdin.isatty():
            error("Pass a note number as an argument (non-interactive mode).")
            sys.exit(1)
        print("Open decision notes:")
        for n in decisions:
            print(f"  [{n['number']:03d}] {n['path'].name}")
        choice = input("Graduate which note number? > ").strip()
        try:
            note_num = int(choice)
        except ValueError:
            error(f"'{choice}' is not a note number.")
            sys.exit(1)

    note = next((n for n in decisions if n["number"] == note_num), None)
    if note is None:
        error(f"No open decision note numbered {note_num:03d}.")
        sys.exit(1)

    try:
        result = graduate_one(workspace, note, domain=args.domain, kind=args.kind, slug=args.slug)
    except GraduationError as exc:
        error(str(exc))
        sys.exit(1)

    success(f"Scaffolded {result['scaffold_path']}")
    info(f"Note marked graduated → {result['graduated_to']}")
    info(
        "Ask Claude to run the sb-author skill to fill in the placeholder, "
        "then `sandbox skills check` before committing."
    )


def run(args) -> None:
    """Execute ``sandbox notes <action>``."""
    if args.action == "graduate":
        _run_graduate(args)
        return

    # context: hook-safe, must never raise or break a session launch
    try:
        workspace = find_workspace_root(Path.cwd())
        if workspace is None:
            return
        context = build_context(workspace)
        if context:
            print(context, end="")
    except Exception:  # noqa: BLE001 — a context hook must never break a launch
        return
```

- [ ] **Step 4: Implement — `cli/main.ts` parser**

In `apps/cli/src/main.ts`, replace:

```node
    # ---- notes ------------------------------------------------------------
    p_notes = subparsers.add_parser(
        "notes",
        help=(
            "Workspace notes (.sandbox/notes/). `context` prints the latest "
            "handoff + open decisions for session-start injection (hook target)."
        ),
    )
    p_notes.add_argument(
        "action", choices=["context"],
        help="context: print notes context for the enclosing workspace (silent if none)",
    )
```

with:

```node
    # ---- notes ------------------------------------------------------------
    p_notes = subparsers.add_parser(
        "notes",
        help=(
            "Workspace notes (.sandbox/notes/). `context` prints the latest "
            "handoff + open decisions for session-start injection (hook target); "
            "`graduate` scaffolds an open decision note into docs/standards/."
        ),
    )
    p_notes.add_argument(
        "action", choices=["context", "graduate"],
        help=(
            "context: print notes context for the enclosing workspace (silent if none); "
            "graduate: scaffold an open decision note into docs/standards/"
        ),
    )
    p_notes.add_argument(
        "note_num", nargs="?", default=None, type=int,
        help="graduate: note number to graduate (omit to pick interactively)",
    )
    p_notes.add_argument(
        "--domain", default=None,
        help="graduate: target docs/standards/<domain> (omit to infer from refs, or prompt)",
    )
    p_notes.add_argument(
        "--kind", choices=["rule", "example", "anti-pattern"], default=None,
        help="graduate: content kind to scaffold (omit to prompt)",
    )
    p_notes.add_argument(
        "--slug", default=None,
        help="graduate: override the derived reference-file slug",
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -q
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/notes.ts apps/cli/src/main.ts apps/cli/src/lib/__tests__/notes.test.ts
git commit -m "feat(sandbox-cli): sandbox notes graduate command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `sandbox down` graduates interactively, with a TTY guard

**Files:**
- Modify: `apps/cli/src/commands/down.ts`
- Modify (existing test, add TTY monkeypatch so it can never block on `input()`): `apps/cli/src/lib/__tests__/notes.test.ts::test_down_prints_latest_handoff_and_open_decisions`
- Test: `apps/cli/src/lib/__tests__/notes.test.ts`

**Interfaces:**
- Consumes: `cli.commands.notes.graduate_one` (Task 4), `cli.lib.graduate.GraduationError` (Task 1).
- Produces: no new public interface — `down._print_notes(feature)` keeps its signature.

- [ ] **Step 1: Update the existing test to guard against hanging on `input()`**

In `apps/cli/src/lib/__tests__/notes.test.ts`, find `test_down_prints_latest_handoff_and_open_decisions` and add the TTY monkeypatch (matching the precedent already used in `test_init_workspace_creates_notes_dir_and_notes_survive_rerun`):

```node
def test_down_prints_latest_handoff_and_open_decisions(tmp_path: Path, monkeypatch, capsys) -> None:
    from cli.commands import down

    directory = notes_dir(tmp_path)
    _write_note(directory, "001-handoff-old.md", "handoff", status="superseded",
                body="Stale handoff.")
    _write_note(directory, "002-handoff-current.md", "handoff", body="Resume from here.")
    _write_note(directory, "003-decision-schema.md", "decision", body="Schema is settled.")
    _write_note(directory, "004-decision-dead.md", "decision", status="superseded",
                body="Old decision.")
    _write_note(directory, "005-finding-root-cause.md", "finding", body="Not printed.")

    monkeypatch.setattr(down, "workspace_for_feature", lambda feature: tmp_path)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)  # non-TTY: print-only, never calls input()
    down._print_notes("myfeat")

    out = capsys.readouterr().out
    assert "002-handoff-current.md" in out
    assert "Resume from here." in out
    assert "003-decision-schema.md" in out
    assert "Schema is settled." in out
    assert "Stale handoff." not in out
    assert "Old decision." not in out
    assert "Not printed." not in out
```

- [ ] **Step 2: Write the new failing tests**

Add right after the updated test above:

```node
def test_down_non_tty_never_calls_input(tmp_path: Path, monkeypatch, capsys) -> None:
    from cli.commands import down

    _write_note(notes_dir(tmp_path), "001-decision-x.md", "decision", body="Decided X.")
    monkeypatch.setattr(down, "workspace_for_feature", lambda feature: tmp_path)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    def _boom(prompt=""):
        raise AssertionError("must not prompt when not attached to a TTY")
    monkeypatch.setattr("builtins.input", _boom)

    down._print_notes("myfeat")  # must not raise
    assert "sandbox notes graduate" in capsys.readouterr().out


def test_down_tty_graduate_scaffolds_and_marks_note(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    from cli.commands import down

    # SANDBOX_ROOT (not a direct load_standards_modules monkeypatch): both
    # graduate_one's own load_standards_modules() call AND graduate_note's
    # internal default standards_dir resolution go through get_sandbox_root(),
    # which re-reads this env var on every call — one override redirects both
    # (Task 4's review found that patching only one of the two call sites lets
    # the other silently fall through to the real repo's docs/standards/).
    fake_root = tmp_path / "fake_sandbox_root"
    standards_dir = fake_root / "docs" / "standards"
    (standards_dir / "api").mkdir(parents=True)
    (standards_dir / "api" / "STANDARD.md").write_text(
        "---\ndomain: api\napplies_to: []\nphase: [implement, review]\n"
        "summary: API standard.\n---\n\n# API\n\n## Rules\n\n- X.\n\n## Don't\n\n"
        "- Y — [references/ap-a.md](references/ap-a.md)\n\n## Going deeper\n"
        "| a | b |\n|---|---|\n| a | [references/ap-a.md](references/ap-a.md) |\n"
    )
    (standards_dir / "api" / "references").mkdir()
    (standards_dir / "api" / "references" / "ap-a.md").write_text(
        "---\nkind: anti-pattern\n---\n\nWar story.\n"
    )
    monkeypatch.setenv("SANDBOX_ROOT", str(fake_root))

    workspace = tmp_path / "workspace"
    _write_note(notes_dir(workspace), "003-decision-pagination.md", "decision",
                body="We picked cursor pagination.")

    monkeypatch.setattr(down, "workspace_for_feature", lambda feature: workspace)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    inputs = iter(["g", "api", "rule"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(inputs))

    down._print_notes("myfeat")

    from cli.lib.notes import open_decisions
    assert open_decisions(workspace) == []
    assert "TODO(graduate)" in (standards_dir / "api" / "STANDARD.md").read_text()


def test_down_graduation_failure_never_blocks_teardown(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    from cli.commands import down

    fake_root = tmp_path / "fake_sandbox_root"
    standards_dir = fake_root / "docs" / "standards"
    (standards_dir / "api").mkdir(parents=True)
    (standards_dir / "api" / "STANDARD.md").write_text(
        "---\ndomain: api\napplies_to: []\nphase: [implement, review]\n"
        "summary: API standard.\n---\n\n# API\n\n## Rules\n\n- X.\n\n## Don't\n\n"
        "- Y — [references/ap-a.md](references/ap-a.md)\n\n## Going deeper\n"
        "| a | b |\n|---|---|\n| a | [references/ap-a.md](references/ap-a.md) |\n"
    )
    (standards_dir / "api" / "references").mkdir()
    (standards_dir / "api" / "references" / "ap-a.md").write_text(
        "---\nkind: anti-pattern\n---\n\nWar story.\n"
    )
    monkeypatch.setenv("SANDBOX_ROOT", str(fake_root))

    workspace = tmp_path / "workspace"
    _write_note(notes_dir(workspace), "003-decision-x.md", "decision", body="X.")

    monkeypatch.setattr(down, "workspace_for_feature", lambda feature: workspace)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    inputs = iter(["g", "not-a-real-domain", "rule"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(inputs))

    down._print_notes("myfeat")  # must not raise
    assert "Could not graduate" in capsys.readouterr().out
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

```bash
npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -k "down_non_tty or down_tty_graduate or down_graduation_failure" -q
```

Expected: FAIL — `_print_notes` doesn't prompt or graduate yet.

- [ ] **Step 4: Implement**

Replace `_print_notes` in `apps/cli/src/commands/down.ts`:

```node
def _print_notes(feature: str) -> None:
    """Print the latest handoff note; offer to graduate open decision notes.

    jit-notes-and-handoffs-spec.md §4.6 / 2026-07-12-authoring-pipeline-
    design.md: the human decides what graduates. At a real terminal, offer
    to graduate each open decision note on the spot; otherwise (--all-
    features, the mcp-workspace `workspace-action`/`remove-workspace` tools)
    fall back to print-only — never block on stdin. Printing/graduation
    failures never block teardown. Must run before containers are removed:
    the workspace lookup reads compose labels off the feature's containers.
    """
    try:
        workspace = workspace_for_feature(feature)
        if workspace is None:
            return
        handoff = latest_handoff(workspace)
        if handoff is not None:
            print(f"{Colors.BOLD}Latest handoff{Colors.RESET} — review before this context is gone:\n")
            _print_note(handoff, workspace)

        decisions = open_decisions(workspace)
        if not decisions:
            return

        if not sys.stdin.isatty():
            print(
                f"{Colors.BOLD}Open decision notes{Colors.RESET} — graduate what "
                f"should outlive the feature (PR body, Jira, docs/standards); "
                f"run `sandbox notes graduate` to do it:\n"
            )
            for note in decisions:
                _print_note(note, workspace)
            return

        from cli.commands.notes import graduate_one
        from cli.lib.graduate import GraduationError

        for note in decisions:
            _print_note(note, workspace)
            choice = input(f"  Graduate {note['path'].name}? [g/s] > ").strip().lower()
            if choice != "g":
                continue
            try:
                result = graduate_one(workspace, note, domain=None, kind=None, slug=None)
            except GraduationError as exc:
                warn(f"Could not graduate {note['path'].name}: {exc}")
                continue
            info(
                f"Scaffolded {result['scaffold_path']} — run sb-author to fill it "
                f"in, then `sandbox skills check`."
            )
    except Exception as exc:  # noqa: BLE001 — never block teardown on printing
        warn(f"Could not print workspace notes: {exc}")


def _print_note(note: dict, workspace: Path) -> None:
    rel = note["path"].relative_to(workspace)
    print(f"  {Colors.YELLOW}── {rel} ──{Colors.RESET}")
    for line in note["body"].strip().splitlines():
        print(f"  {line}")
    print()
```

`sys` is already imported at the top of `down.ts`; no new top-level import needed (the `cli.commands.notes`/`cli.lib.graduate` imports are deliberately local to the TTY branch, mirroring `down.ts`'s existing local import of `cli.lib.infra` for the same reason — avoid pulling in a heavier module for the common non-TTY/no-decisions path).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -q
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/down.ts apps/cli/src/lib/__tests__/notes.test.ts
git commit -m "feat(sandbox-cli): sandbox down graduates decision notes interactively

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `sb-author` skill

**Files:**
- Create: `infra/skills/sb-author/SKILL.md`
- Modify: `apps/cli/src/lib/workspace_skills.ts:14-19` (docstring count)
- Modify: `apps/cli/src/lib/__tests__/workspace_skills.test.ts:63-68` (exact-set assertion)

**Interfaces:**
- Consumes: nothing from other tasks (reads whatever `graduate_note` scaffolded).
- Produces: the skill name `sb-author`, picked up automatically by the existing glob-based projection (`cli.lib.workspace_skills.render_workspace_skills` — `source.glob("*/SKILL.md")`, no code change needed there).

- [ ] **Step 1: Update the exact-set test (will fail until Step 2)**

In `apps/cli/src/lib/__tests__/workspace_skills.test.ts`, change:

```node
def test_real_repo_renders_all_skills() -> None:
    rendered = render_workspace_skills(
        REPO_ROOT / "docs" / "standards", REPO_ROOT / "infra" / "skills"
    )
    assert set(rendered) == {
        "sb-comments-standard", "sb-ui-standard", "sb-api-standard",
        "sb-graphql-standard", "sb-data-standard",
        "sb-implement", "sb-research", "sb-test", "sb-handoff", "sb-review",
        "sb-pr",
    }
```

to:

```node
def test_real_repo_renders_all_skills() -> None:
    rendered = render_workspace_skills(
        REPO_ROOT / "docs" / "standards", REPO_ROOT / "infra" / "skills"
    )
    assert set(rendered) == {
        "sb-comments-standard", "sb-ui-standard", "sb-api-standard",
        "sb-graphql-standard", "sb-data-standard",
        "sb-implement", "sb-research", "sb-test", "sb-handoff", "sb-review",
        "sb-pr", "sb-author",
    }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts::test_real_repo_renders_all_skills -q
```

Expected: FAIL — `sb-author` missing from the rendered set.

- [ ] **Step 3: Create the skill file**

Write `infra/skills/sb-author/SKILL.md` with exactly this content:

````markdown
---
name: sb-author
description: "Fill in a scaffolded standards graduation after `sandbox notes graduate` or `sandbox down` has created a placeholder. Use when asked to 'graduate this note', 'fill in the standards scaffold', or finish a TODO(graduate) marker left by graduation."
---

# sb-author — fill in a graduation scaffold

`sandbox notes graduate` / `sandbox down` do the mechanical part: they scaffold
placeholder content and wire the structural links, then mark the source
`decision` note `status: graduated` with a `graduated_to:` path. They never
write the actual prose — that judgment call is this skill's job.

1. **Find the placeholder** — the `graduated_to` path in the note's
   frontmatter, or search `docs/standards/` for a
   `<!-- TODO(graduate): fill from note NNN, see ... -->` marker.
2. **Read the original decision note** (`.sandbox/notes/NNN-decision-*.md`,
   even though it's now `status: graduated` — it's still there as the
   record of what was decided) and its `refs`. Open the referenced files or
   repo to ground the content in real code; don't invent an example that
   doesn't exist somewhere.
3. **Fill in the placeholder**, replacing every `TODO`/`TODO(graduate)` marker:
   - **`rule`** (a bullet in `## Rules`): replace the TODO bullet with real
     prose — a bold title plus the rule, in the voice of the other bullets
     already in that section.
   - **`example`** (`references/<slug>.md`): confirm or write the real
     `canonical: repo:path` in frontmatter, write a ~10–20 line excerpt under
     `## The load-bearing part`, and fill in the `## Going deeper` row's task
     description in `STANDARD.md`.
   - **`anti-pattern`** (`references/ap-<slug>.md`): write
     `## What it looks like` (the bad code), `## Why it's wrong` (cite the
     real repo:path it was mined from if findable), `## The fix`; fill in
     the `## Don't` bullet's one-liner and the `## Going deeper` row's task
     description.
4. **Run `sandbox skills check`** and report pass/fail before suggesting the
   human commit — it fails loudly if any `TODO(graduate)` marker or
   placeholder `canonical: TODO` is still left anywhere.

If no placeholder can be found (nothing scaffolded yet, or it's already been
filled), say so once and stop — don't invent a note to graduate.
````

- [ ] **Step 4: Update the workspace_skills.ts docstring**

In `apps/cli/src/lib/workspace_skills.ts`, change:

```node
- the six hand-authored entry skills (sb-implement, sb-research, sb-test,
  sb-handoff, sb-review, sb-pr) are read verbatim from infra/skills/ as
  one-file {"SKILL.md": content} bundles.
```

to:

```node
- the seven hand-authored entry skills (sb-implement, sb-research, sb-test,
  sb-handoff, sb-review, sb-pr, sb-author) are read verbatim from
  infra/skills/ as one-file {"SKILL.md": content} bundles.
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -q
```

Expected: all pass, including `test_real_repo_renders_all_skills`.

- [ ] **Step 6: Run the full suite (final regression guard)**

```bash
npx vitest run apps/cli/src/lib/__tests__/ -q
```

Expected: all pass except the pre-existing, unrelated known failure
`secrets_check.test.ts::test_required_secret_keys_matches_env_j2_set`
(documented in `docs/jit-content-HANDOFF.md` — env.j2 gained Tina/NextAuth
secret vars without a matching required-secrets update; not touched by this
plan).

- [ ] **Step 7: Commit**

```bash
git add infra/skills/sb-author/SKILL.md apps/cli/src/lib/workspace_skills.ts apps/cli/src/lib/__tests__/workspace_skills.test.ts
git commit -m "feat(skills): sb-author — fill in standards-graduation scaffolds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
