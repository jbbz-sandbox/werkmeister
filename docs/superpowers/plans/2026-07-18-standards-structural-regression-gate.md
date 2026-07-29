# Standards structural regression gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic per-edit gate that fails loudly when a `docs/standards/` module is structurally broken, instead of the module silently dropping out of the forgiving loader.

**Architecture:** A new `validate_standard_modules` in `apps/cli/src/lib/standards.ts` scans the standards source files directly (upstream of `load_standards_modules`, which silently skips malformed files) and returns error strings. A new `sandbox standards check` command runs it plus the two existing source-tree validators and exits non-zero on any error. A repo-level vitest test asserts the real tree passes all three — so the existing suite (this repo's de-facto CI + the pre-PR checklist) goes red on a broken standard.

**Tech Stack:** Node 20+, stdlib only, `vitest` (run via `npx vitest run`), `pyyaml` (already used via `_parse_frontmatter`).

## Global Constraints

- Package imported as `cli` (container `apps/cli/`). Tests in `apps/cli/src/lib/__tests__/`, discovered by the vitest config in `apps/cli`.
- **Validators return `list[str]` and never raise** — matches the existing `validate_module_references` / `validate_service_standards` contract.
- **`validate_standard_modules` scans files directly** — `standards_dir.glob("*.md")` + `standards_dir.glob("*/STANDARD.md")` (the same globs `load_standards_modules` uses), parsing each with `_parse_frontmatter`. It must NOT call `load_standards_modules` (that is the function whose silent drop it exists to catch). `docs/standards/repos/*.md` are excluded automatically (not `*/STANDARD.md`, not top-level `*.md`).
- **The 5 checks, per scanned file, accumulate all errors:**
  1. Frontmatter integrity — `_parse_frontmatter` returns `{}` OR no non-empty string `domain:` → error, and **skip that file's remaining checks**.
  2. `summary:` present + non-empty string.
  3. `applies_to:` present, a non-empty list, every item a non-empty string.
  4. `phase:` **shape-only** — if present, must be a non-empty list of non-empty strings. **No vocabulary allow-list.** Absence is allowed. (A scalar `phase: implement` string silently breaks skill_gen's `"implement" in phases` substring test.)
  5. `domain:` matches location — parent dir name for `<dir>/STANDARD.md`, file stem for flat `<key>.md`.
- **Command is separate from `sandbox skills check`** (which stays workspace-scoped for projection staleness).
- No new dependency. No pre-commit hook, no GitHub Actions (decided out). Behavioral eval is a separate project.
- Commit messages end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Spec: [docs/superpowers/specs/2026-07-18-standards-structural-regression-gate-design.md](../specs/2026-07-18-standards-structural-regression-gate-design.md).

---

### Task 1: `validate_standard_modules` validator

**Files:**
- Modify: `apps/cli/src/lib/standards.ts` (add the function)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts`

**Interfaces:**
- Consumes: `_parse_frontmatter` (existing, same module); `get_sandbox_root` (already imported at `standards.ts:28`).
- Produces: `validate_standard_modules(standards_dir: Path | None = None) -> list[str]` — error strings for a structurally broken standards tree; `[]` when clean or the dir is absent; never raises.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/lib/__tests__/standards.test.ts`:

```node
from cli.lib.standards import validate_standard_modules


def _write_std_file(root: Path, relpath: str, frontmatter: str) -> Path:
    p = root / relpath
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"---\n{frontmatter}\n---\n\n# body\n")
    return p


_VALID_FM = (
    "domain: service\n"
    "summary: Service standard.\n"
    'applies_to:\n  - "**/*.service.ts"\n'
    "phase:\n  - implement\n  - review"
)


def test_validate_standard_modules_clean(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md", _VALID_FM)
    assert validate_standard_modules(tmp_path) == []


def test_validate_standard_modules_unparseable_frontmatter(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md", "domain: [unclosed")
    errors = validate_standard_modules(tmp_path)
    assert len(errors) == 1
    assert "unparseable frontmatter or missing" in errors[0]


def test_validate_standard_modules_missing_domain(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md",
                    'summary: S.\napplies_to:\n  - "**/*.ts"')
    errors = validate_standard_modules(tmp_path)
    assert errors == [f"{Path('service/STANDARD.md')}: unparseable frontmatter or missing `domain:`"]


def test_validate_standard_modules_empty_summary(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md",
                    'domain: service\nsummary: "   "\napplies_to:\n  - "**/*.ts"')
    errors = validate_standard_modules(tmp_path)
    assert any("missing or empty `summary:`" in e for e in errors)


def test_validate_standard_modules_empty_applies_to(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md",
                    "domain: service\nsummary: S.\napplies_to: []")
    errors = validate_standard_modules(tmp_path)
    assert any("applies_to" in e for e in errors)


def test_validate_standard_modules_scalar_phase(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md",
                    'domain: service\nsummary: S.\napplies_to:\n  - "**/*.ts"\nphase: implement')
    errors = validate_standard_modules(tmp_path)
    assert any("`phase:`" in e for e in errors)


def test_validate_standard_modules_accepts_test_phase_and_absent_phase(tmp_path: Path) -> None:
    # phase: [test] is an unknown-but-valid vocabulary value -> not rejected.
    _write_std_file(tmp_path, "svc-a/STANDARD.md",
                    'domain: svc-a\nsummary: S.\napplies_to:\n  - "**/*.ts"\nphase:\n  - test')
    assert validate_standard_modules(tmp_path) == []
    # No phase key at all -> allowed (skill_gen defaults it).
    import shutil
    shutil.rmtree(tmp_path / "svc-a")
    _write_std_file(tmp_path, "svc-b/STANDARD.md",
                    'domain: svc-b\nsummary: S.\napplies_to:\n  - "**/*.ts"')
    assert validate_standard_modules(tmp_path) == []


def test_validate_standard_modules_domain_location_mismatch(tmp_path: Path) -> None:
    _write_std_file(tmp_path, "service/STANDARD.md",
                    'domain: auth\nsummary: S.\napplies_to:\n  - "**/*.ts"')
    errors = validate_standard_modules(tmp_path)
    assert any("does not match its location" in e for e in errors)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k validate_standard_modules -q`
Expected: FAIL — `ImportError: cannot import name 'validate_standard_modules'`.

- [ ] **Step 3: Implement the validator**

Add to `apps/cli/src/lib/standards.ts` (below `validate_service_standards`, above `resolve_active_standards`):

```node
def validate_standard_modules(standards_dir: Path | None = None) -> list[str]:
    """Structural integrity of the standards source tree (regression gate).

    Scans the standard-shaped files DIRECTLY — the same globs
    load_standards_modules uses — and parses each itself, rather than trusting
    load_standards_modules' output: that loader deliberately *drops* files with
    malformed frontmatter or no domain (forgiving, so one bad edit can't break
    workspace init), which is exactly why such breakage is silent. This
    validator looks upstream of that safety net. Returns error strings; never
    raises. repos/*.md are excluded (they are not *.md at top level nor
    */STANDARD.md).
    """
    if standards_dir is None:
        standards_dir = get_sandbox_root() / "docs" / "standards"
    errors: list[str] = []
    if not standards_dir.is_dir():
        return errors

    paths = sorted(standards_dir.glob("*.md")) + sorted(standards_dir.glob("*/STANDARD.md"))
    for path in paths:
        rel = path.relative_to(standards_dir)
        meta = _parse_frontmatter(path)

        domain = meta.get("domain")
        if not (isinstance(domain, str) and domain.strip()):
            errors.append(f"{rel}: unparseable frontmatter or missing `domain:`")
            continue  # every remaining check needs a parsed dict

        summary = meta.get("summary")
        if not (isinstance(summary, str) and summary.strip()):
            errors.append(f"{rel}: missing or empty `summary:`")

        applies_to = meta.get("applies_to")
        if not (
            isinstance(applies_to, list)
            and applies_to
            and all(isinstance(g, str) and g.strip() for g in applies_to)
        ):
            errors.append(
                f"{rel}: `applies_to:` must be a non-empty list of non-empty globs "
                f"(empty means the standard never loads and never re-injects)"
            )

        phase = meta.get("phase")
        if phase is not None and not (
            isinstance(phase, list)
            and phase
            and all(isinstance(p, str) and p.strip() for p in phase)
        ):
            errors.append(
                f"{rel}: `phase:` if present must be a non-empty list of strings "
                f"(a scalar string silently breaks skill_gen's substring gate)"
            )

        expected = path.parent.name if path.name == "STANDARD.md" else path.stem
        if domain.strip() != expected:
            errors.append(
                f"{rel}: `domain: {domain}` does not match its location "
                f"(expected `{expected}` — tr-<domain>-standard would diverge "
                f"from where the standard lives)"
            )

    return errors
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k validate_standard_modules -q`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/standards.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "feat(jit): validate_standard_modules — structural gate for docs/standards/

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `sandbox standards check` command + wiring + regression net

**Files:**
- Create: `apps/cli/src/commands/standards.ts`
- Modify: `apps/cli/src/main.ts` (subparser + `_COMMAND_MODULES` entry)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts`

**Interfaces:**
- Consumes: `validate_standard_modules` (Task 1); `validate_service_standards`, `load_standards_modules` (existing, `cli.lib.standards`); `validate_module_references` (existing, `cli.lib.skill_gen`); `load_services`, `error`, `info`, `success` (existing, `cli.lib.config`).
- Produces: `cli.commands.standards.run(args)` — prints all source-tree validation errors and `sys.exit(1)` if any; success line + exit 0 when clean.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/src/lib/__tests__/standards.test.ts`:

```node
def test_real_standards_tree_is_valid() -> None:
    """Regression net: the committed docs/standards/ tree passes all three
    source-tree validators. Goes red the moment a malformed standard lands."""
    from cli.lib.config import load_services
    from cli.lib.skill_gen import validate_module_references

    modules = load_standards_modules()
    assert validate_standard_modules() == []
    assert validate_module_references(modules) == []
    assert validate_service_standards(load_services(), modules) == []


def test_standards_check_command_exits_1_on_error(monkeypatch, capsys) -> None:
    import argparse

    from cli.commands import standards as standards_cmd

    monkeypatch.setattr(standards_cmd, "validate_standard_modules",
                        lambda: ["svc/STANDARD.md: missing or empty `summary:`"])
    monkeypatch.setattr(standards_cmd, "validate_module_references", lambda modules: [])
    monkeypatch.setattr(standards_cmd, "validate_service_standards", lambda svcs, mods: [])

    with vitest.raises(SystemExit) as exc:
        standards_cmd.run(argparse.Namespace(action="check"))
    assert exc.value.code == 1
    assert "missing or empty `summary:`" in capsys.readouterr().out


def test_standards_check_command_exits_0_when_clean(monkeypatch, capsys) -> None:
    import argparse

    from cli.commands import standards as standards_cmd

    monkeypatch.setattr(standards_cmd, "validate_standard_modules", lambda: [])
    monkeypatch.setattr(standards_cmd, "validate_module_references", lambda modules: [])
    monkeypatch.setattr(standards_cmd, "validate_service_standards", lambda svcs, mods: [])

    standards_cmd.run(argparse.Namespace(action="check"))  # must not raise
    assert "well-formed" in capsys.readouterr().out
```

(`vitest` is already imported at the top of `standards.test.ts`; add the import only if missing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k "real_standards_tree or standards_check_command" -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'cli.commands.standards'` (and the real-tree test errors on the same import).

- [ ] **Step 3: Create the command module**

Create `apps/cli/src/commands/standards.ts`:

```node
"""
sandbox standards check — structural regression gate over the docs/standards/
source tree (2026-07-18-standards-structural-regression-gate-design.md).

Runs the three source-tree validators and exits non-zero on any error, so a
malformed standards edit fails loudly instead of silently dropping out of
load_standards_modules. Separate from `sandbox skills check`, which is
workspace-scoped (projection staleness).
"""

from __future__ import annotations

import sys

from cli.lib.config import error, info, load_services, success
from cli.lib.skill_gen import validate_module_references
from cli.lib.standards import (
    load_standards_modules,
    validate_service_standards,
    validate_standard_modules,
)


def run(args) -> None:
    modules = load_standards_modules()
    errors = (
        validate_standard_modules()
        + validate_module_references(modules)
        + validate_service_standards(load_services(), modules)
    )
    if errors:
        error(f"docs/standards/ has {len(errors)} problem(s):")
        for e in errors:
            info(f"  - {e}")
        sys.exit(1)
    success(f"docs/standards/ is well-formed ({len(modules)} standard module(s) checked).")
```

- [ ] **Step 4: Wire the subcommand into `main.ts`**

In `apps/cli/src/main.ts`, add this subparser block immediately after the `skills` block (the `p_skills.add_argument(...)` ending at the `# ---- notes` comment):

```node
    # ---- standards --------------------------------------------------------
    p_standards = subparsers.add_parser(
        "standards",
        help="Validate the docs/standards/ source tree (structural regression gate)",
    )
    p_standards.add_argument(
        "action", choices=["check"],
        help="check: exit 1 if any standard module is structurally malformed",
    )
```

Then add to the `_COMMAND_MODULES` dict (after the `"skills"` entry):

```node
    "standards":        "cli.commands.standards",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -k "real_standards_tree or standards_check_command" -q`
Expected: PASS (3 passed). If `test_real_standards_tree_is_valid` fails, a real standard is genuinely malformed — read the assertion diff; do not weaken the test.

- [ ] **Step 6: Smoke-test the command end to end**

Run: `node apps/cli/dist/main.js standards check`
Expected: prints a success line like `docs/standards/ is well-formed (8 standard module(s) checked).` and exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/commands/standards.ts apps/cli/src/main.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "feat(jit): sandbox standards check command + real-tree regression test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Full-suite regression, format, and docs

**Files:**
- Modify: `docs/jit-README.md` (Validation gates section)

**Interfaces:** none (verification + docs).

- [ ] **Step 1: Formatting pass**

Run: `npm --prefix apps/cli run ruff format apps/cli/src/lib/standards.ts apps/cli/src/commands/standards.ts apps/cli/src/main.ts apps/cli/src/lib/__tests__/standards.test.ts`
Then: `npm --prefix apps/cli run ruff check apps/cli/src/lib/standards.ts apps/cli/src/commands/standards.ts` — report findings; fix only ones this feature introduced, not pre-existing repo-wide issues.

- [ ] **Step 2: Full suite**

Run: `npx vitest run apps/cli/src/lib/__tests__/ -q`
Expected: all pass EXCEPT the one known pre-existing unrelated failure `secrets_check.test.ts::test_required_secret_keys_matches_env_j2_set` (confirmed pre-existing on this branch). Report the count. If any OTHER test fails, determine whether this feature caused it; do not fix unrelated pre-existing failures, but report them.

- [ ] **Step 3: Update the Validation gates doc**

In `docs/jit-README.md`, under `## Validation gates`, replace:

```
- `sandbox skills check` / `sync` — staleness of projected workspace skills
  (`apps/cli/src/commands/skills.ts`)
- `validate_module_references` — fails on dead pointers, lingering `TODO(graduate)`
  markers, or placeholder `canonical: TODO`
```

with:

```
- `sandbox standards check` — structural gate over the `docs/standards/` **source**
  tree: `validate_standard_modules` (frontmatter integrity + summary/applies_to/phase
  shape + domain-matches-location) plus `validate_module_references` and
  `validate_service_standards`. Exits 1 on any malformed standard; asserted clean by
  `standards.test.ts::test_real_standards_tree_is_valid` so the suite catches regressions
  (`apps/cli/src/commands/standards.ts`).
- `sandbox skills check` / `sync` — staleness of projected workspace skills
  (`apps/cli/src/commands/skills.ts`)
- `validate_module_references` — fails on dead pointers, lingering `TODO(graduate)`
  markers, or placeholder `canonical: TODO`
```

- [ ] **Step 4: Commit**

```bash
git add docs/jit-README.md apps/cli/src/
git commit -m "docs(jit): document sandbox standards check gate in current-state index

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- 5 checks (integrity/summary/applies_to/phase-shape/domain-location) → Task 1 validator + 8 unit tests. ✓
- Scans files directly, not via load_standards_modules → Task 1 implementation + Global Constraints. ✓
- phase shape-only, accepts `[test]` and absent → `test_validate_standard_modules_accepts_test_phase_and_absent_phase`. ✓
- `sandbox standards check` runs all three validators, exits 1/0 → Task 2 command + 2 command tests. ✓
- Repo-level real-tree regression test → Task 2 `test_real_standards_tree_is_valid`. ✓
- Separate from `sandbox skills check` → new command module, skills untouched. ✓
- No new dep, no pre-commit/CI, behavioral eval out → nothing in plan adds them. ✓
- Docs (Validation gates) → Task 3. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `validate_standard_modules(standards_dir=None) -> list[str]` defined in Task 1, imported+monkeypatched with the same shape in Task 2. Command monkeypatches `validate_module_references`/`validate_service_standards` with the arities the command calls them (`lambda modules:` / `lambda svcs, mods:`), matching `validate_module_references(modules)` and `validate_service_standards(load_services(), modules)` in the command body. `run(argparse.Namespace(action="check"))` matches the subparser's `action` positional.
