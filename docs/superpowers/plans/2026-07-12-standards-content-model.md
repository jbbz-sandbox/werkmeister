# Standards Content Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a JIT tier-2 content layer (examples + anti-patterns as on-demand reference files) to the standards system, and fill the REST/API module as the proving ground.

**Architecture:** Domain standards move from flat `docs/standards/<key>.md` to `docs/standards/<key>/STANDARD.md` + `references/*.md`. The render pipeline (`skill_gen`) produces per-skill *file bundles* instead of single SKILL.md strings; projection (`workspace_skills`) writes/prunes/checks the whole set. References travel with the skill, so links to them stay relative — no GitHub rewriting.

**Tech Stack:** Node 20+, vitest (run via `npx vitest run` from the repo root), PyYAML frontmatter parsing. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-standards-content-model-design.md` — read it before starting any task.

## Global Constraints

- Both module forms must work: flat `<key>.md` AND `<key>/STANDARD.md`. A half-migrated tree must never break `sandbox init-workspace`.
- `STANDARD.md` frontmatter contract is unchanged: `domain / applies_to / phase / summary`. Zero changes to `services.yaml`, archetype resolution, or the CLAUDE.md routing table.
- Reference files: `kind: example` (requires `canonical: repo:path` frontmatter) or `kind: anti-pattern` (filename prefix `ap-`).
- Init stays permissive: malformed modules warn and skip. Authoring invariants are enforced only by `sandbox skills check` and unit tests.
- STANDARD.md body budget ≤ ~800 tokens (guidance, not enforced by code).
- All generated GitHub links for sandbox files target branch `multi-feature` (existing `GITHUB_BRANCH` constant). Canonical-file links for *service* repos use `https://github.com/sandbox/<repo>/blob/HEAD/<path>` (HEAD = default branch).
- Run tests from the repo root: `npx vitest run apps/cli/src/lib/__tests__/<file> -q`.
- Commit messages follow conventional commits and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Directory-form module discovery (`standards.ts`)

**Files:**
- Modify: `apps/cli/src/lib/standards.ts:31-53` (`load_standards_modules`)
- Test: `apps/cli/src/lib/__tests__/standards.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `load_standards_modules()` additionally discovers `<key>/STANDARD.md` modules; a directory-form module with a non-empty `references/` gets metadata key `references_dir: Path`. Flat modules and directory modules without references have **no** `references_dir` key. Everything else (`path`, frontmatter keys) is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/lib/__tests__/standards.test.ts` (match the file's existing import of `load_standards_modules`; add it if absent):

```node
# ---------------------------------------------------------------------------
# Directory-form modules (content-model spec §5, standards.ts discovery)
# ---------------------------------------------------------------------------

def _write_module(root, name, body="# X\n", frontmatter=None):
    fm = frontmatter or f"domain: {name}\nsummary: {name} standard.\n"
    (root / name).mkdir(parents=True, exist_ok=True)
    path = root / name / "STANDARD.md"
    path.write_text(f"---\n{fm}---\n\n{body}")
    return path


def test_directory_form_module_discovered(tmp_path):
    path = _write_module(tmp_path, "api")
    modules = load_standards_modules(tmp_path)
    assert modules["api"]["path"] == path
    assert "references_dir" not in modules["api"]


def test_directory_form_with_references_sets_references_dir(tmp_path):
    _write_module(tmp_path, "api")
    refs = tmp_path / "api" / "references"
    refs.mkdir()
    (refs / "pagination.md").write_text("---\nkind: example\n---\n\n# P\n")
    modules = load_standards_modules(tmp_path)
    assert modules["api"]["references_dir"] == refs


def test_empty_references_dir_is_ignored(tmp_path):
    _write_module(tmp_path, "api")
    (tmp_path / "api" / "references").mkdir()
    modules = load_standards_modules(tmp_path)
    assert "references_dir" not in modules["api"]


def test_flat_and_directory_forms_coexist(tmp_path):
    (tmp_path / "ui.md").write_text(
        "---\ndomain: ui\nsummary: UI standard.\n---\n\n# UI\n"
    )
    _write_module(tmp_path, "api")
    modules = load_standards_modules(tmp_path)
    assert set(modules) == {"ui", "api"}


def test_non_module_dirs_are_skipped(tmp_path):
    # repos/ has per-repo snippets, no STANDARD.md — must not become a module
    (tmp_path / "repos").mkdir()
    (tmp_path / "repos" / "econx.md").write_text("# econx notes\n")
    assert load_standards_modules(tmp_path) == {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -q -k "directory_form or references_dir or coexist or non_module"`
Expected: FAIL — `KeyError: 'api'` (directory modules not discovered yet).

- [ ] **Step 3: Implement discovery**

In `apps/cli/src/lib/standards.ts`, replace the glob loop inside `load_standards_modules` (currently `for path in sorted(standards_dir.glob("*.md")):`) with:

```node
    for path in sorted(standards_dir.glob("*.md")) + sorted(
        standards_dir.glob("*/STANDARD.md")
    ):
        meta = _parse_frontmatter(path)
        domain = meta.get("domain")
        if not domain:
            continue
        meta["path"] = path
        if path.name == "STANDARD.md":
            refs = path.parent / "references"
            if refs.is_dir() and any(refs.glob("*.md")):
                meta["references_dir"] = refs
        modules[str(domain)] = meta
    return modules
```

Also update the docstring's first line to: `"""Parse docs/standards/ modules (flat <key>.md or <key>/STANDARD.md) into {domain: metadata}."""`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/standards.test.ts -q`
Expected: PASS (all — new and pre-existing).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/standards.ts apps/cli/src/lib/__tests__/standards.test.ts
git commit -m "feat(sandbox-cli): discover directory-form standards modules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Bundle rendering + reference files (`skill_gen.ts`)

**Files:**
- Modify: `apps/cli/src/lib/skill_gen.ts`
- Test: `apps/cli/src/lib/__tests__/skill_gen.test.ts`

**Interfaces:**
- Consumes: `modules[domain]["references_dir"]` from Task 1; `_parse_frontmatter` imported from `cli.lib.standards`.
- Produces:
  - `generate_skills(...) -> dict[str, dict[str, str]]` — **return type changes** from `{skill_name: skill_md_str}` to `{skill_name: {relative_path: content}}`. Every bundle has a `"SKILL.md"` key; directory-form modules with references add `"references/<name>.md"` keys.
  - `validate_module_references(modules=None, standards_dir=None) -> list[str]` — authoring-invariant errors (used by Task 4).
  - Link rule: relative link targets starting with `references/` are left untouched by `_rewrite_links`.
  - Reference rendering: frontmatter stripped; body otherwise verbatim (sibling-relative links resolve in the projected bundle, so no rewriting); `canonical: repo:path` becomes a trailing footer.

- [ ] **Step 1: Update existing tests for the new return type**

In `apps/cli/src/lib/__tests__/skill_gen.test.ts`, every existing subscript of the render result gains `["SKILL.md"]`. E.g. `rendered["sb-graphql-standard"]` → `rendered["sb-graphql-standard"]["SKILL.md"]`, and `skill_name_for(domain) in rendered` assertions stay as-is (bundle dict keys are unchanged names). Update **all** occurrences in the file.

- [ ] **Step 2: Write the failing tests for bundles, link rule, canonical footer, and invariants**

Append to `apps/cli/src/lib/__tests__/skill_gen.test.ts`:

```node
from cli.lib.skill_gen import validate_module_references


@vitest.fixture
def dir_standards(tmp_path: Path) -> Path:
    d = tmp_path / "standards"
    refs = d / "api" / "references"
    refs.mkdir(parents=True)
    (d / "api" / "STANDARD.md").write_text(
        "---\n"
        "domain: api\n"
        'applies_to: ["**/controllers/**"]\n'
        "phase: [implement, review]\n"
        "summary: API standard.\n"
        "---\n\n"
        "# API\n\n"
        "- Don't leak stack traces; return the error contract — "
        "[references/ap-leaky-errors.md](references/ap-leaky-errors.md)\n\n"
        "## Going deeper\n"
        "| When you're doing | Read |\n|---|---|\n"
        "| pagination | [references/pagination.md](references/pagination.md) |\n"
        "| error shapes | [references/ap-leaky-errors.md](references/ap-leaky-errors.md) |\n"
    )
    (refs / "pagination.md").write_text(
        "---\n"
        "kind: example\n"
        "canonical: comx:apps/sb-web-api/src/app/products/products.controller.ts\n"
        "---\n\n"
        "# Cursor pagination\n\nRule text.\n"
    )
    (refs / "ap-leaky-errors.md").write_text(
        "---\nkind: anti-pattern\n---\n\n# Leaky errors\n\nWar story.\n"
    )
    return d


def test_bundle_contains_skill_md_and_references(dir_standards: Path):
    rendered = generate_skills(dir_standards)
    bundle = rendered["sb-api-standard"]
    assert set(bundle) == {
        "SKILL.md",
        "references/pagination.md",
        "references/ap-leaky-errors.md",
    }


def test_references_links_survive_unrewritten(dir_standards: Path):
    skill_md = generate_skills(dir_standards)["sb-api-standard"]["SKILL.md"]
    assert "(references/pagination.md)" in skill_md
    assert "github.com" not in skill_md.split("Going deeper")[1]


def test_reference_renders_with_canonical_footer_and_no_frontmatter(
    dir_standards: Path,
):
    ref = generate_skills(dir_standards)["sb-api-standard"]["references/pagination.md"]
    assert not ref.startswith("---")
    assert "kind: example" not in ref
    assert (
        "https://github.com/sandbox/comx/blob/HEAD/"
        "apps/sb-web-api/src/app/products/products.controller.ts" in ref
    )


def test_anti_pattern_reference_has_no_canonical_footer(dir_standards: Path):
    ref = generate_skills(dir_standards)["sb-api-standard"][
        "references/ap-leaky-errors.md"
    ]
    assert "Full file" not in ref


def test_flat_module_bundle_is_skill_md_only(standards_dir: Path):
    rendered = generate_skills(standards_dir)
    assert set(rendered["sb-graphql-standard"]) == {"SKILL.md"}


def test_validate_passes_on_well_formed_module(dir_standards: Path):
    from cli.lib.standards import load_standards_modules

    assert validate_module_references(load_standards_modules(dir_standards)) == []


def test_validate_flags_unlinked_reference(dir_standards: Path):
    from cli.lib.standards import load_standards_modules

    (dir_standards / "api" / "references" / "error-contracts.md").write_text(
        "---\nkind: example\ncanonical: comx:apps/sb-web-api/src/main.ts\n---\n\n# E\n"
    )
    errors = validate_module_references(load_standards_modules(dir_standards))
    assert errors == [
        "docs/standards/api: references/error-contracts.md is not linked "
        "from STANDARD.md"
    ]


def test_validate_flags_ap_file_without_inline_dont_line(dir_standards: Path):
    from cli.lib.standards import load_standards_modules

    std = dir_standards / "api" / "STANDARD.md"
    # keep the index link, drop the inline don't-line bullet
    std.write_text(std.read_text().replace(
        "- Don't leak stack traces; return the error contract — "
        "[references/ap-leaky-errors.md](references/ap-leaky-errors.md)\n\n",
        "",
    ))
    errors = validate_module_references(load_standards_modules(dir_standards))
    assert errors == [
        "docs/standards/api: references/ap-leaky-errors.md needs an inline "
        "don't-line bullet linking to it"
    ]
```

Note on the ap-invariant test: the "Going deeper" table row also links the ap- file, but a table row (`| ... |`) is not a bullet (`- ...`), so the don't-line check must distinguish them.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts -q`
Expected: FAIL — existing tests fail on `["SKILL.md"]` (str, not dict); new tests fail on import of `validate_module_references`.

- [ ] **Step 4: Implement bundle rendering**

In `apps/cli/src/lib/skill_gen.ts`:

(a) Update the import from standards:

```node
from cli.lib.standards import (
    UNIVERSAL_STANDARD,
    _parse_frontmatter,
    load_standards_modules,
)
```

(b) Add below `_DOCS_STANDARDS_PREFIX`:

```node
# Canonical-example pointers name service repos (comx, econx, …); HEAD links
# resolve to each repo's default branch without pinning one here.
_SERVICE_REPO_BASE = "https://github.com/sandbox"
```

(c) Replace `generate_skills` with:

```node
def generate_skills(
    standards_dir: Path | None = None,
    modules: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, str]]:
    """Render every standards module into {skill_name: {relpath: content}}.

    Every bundle has a "SKILL.md"; directory-form modules with references
    add "references/<name>.md" entries (content-model spec §5).
    """
    if modules is None:
        modules = load_standards_modules(standards_dir)
    known_domains = set(modules)
    rendered: dict[str, dict[str, str]] = {}
    for domain, meta in sorted(modules.items()):
        body = _module_body(meta["path"])
        bundle = {"SKILL.md": _render_skill(domain, meta, body, known_domains)}
        refs_dir = meta.get("references_dir")
        if refs_dir:
            for ref in sorted(Path(refs_dir).glob("*.md")):
                bundle[f"references/{ref.name}"] = _render_reference(ref)
        rendered[skill_name_for(domain)] = bundle
    return rendered
```

(d) Add after `_module_body`:

```node
def _render_reference(path: Path) -> str:
    """A reference file, frontmatter stripped, plus the canonical footer.

    Body links are NOT rewritten: the projected bundle keeps references next
    to SKILL.md, so sibling-relative links resolve as-is (spec §5).
    """
    body = _module_body(path).strip()
    canonical = str(_parse_frontmatter(path).get("canonical") or "")
    if ":" in canonical:
        repo, _, rel = canonical.partition(":")
        body += (
            f"\n\n---\nFull file: `{canonical}` — "
            f"{_SERVICE_REPO_BASE}/{repo}/blob/HEAD/{rel}\n"
        )
    return body + "\n"


def validate_module_references(
    modules: dict[str, dict[str, Any]] | None = None,
    standards_dir: Path | None = None,
) -> list[str]:
    """Authoring invariants (content-model spec §5): every reference is
    linked from its STANDARD.md index; every ap- file additionally has an
    inline don't-line bullet linking to it."""
    if modules is None:
        modules = load_standards_modules(standards_dir)
    errors: list[str] = []
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

(e) In `_rewrite_links._replace`, immediately after the absolute-URL check, add:

```node
        if target.startswith("references/"):
            return match.group(0)
```

(f) `_GENERATED_HEADER` names the source as `docs/standards/{domain}.md`; make it accurate for both forms. Change the format placeholder from `{domain}.md` to `{source}`:

```node
_GENERATED_HEADER = """\
<!--
  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
  Source:    docs/standards/{source} in sandbox (edit that file instead)
  Generator: sandbox init-workspace / sandbox skills sync
             (apps/cli/src/lib/workspace_skills.ts)
  Freshness: sandbox skills check
-->
"""
```

and in `_render_skill`, replace `header = _GENERATED_HEADER.format(domain=domain)` with:

```node
    source = (
        f"{domain}/STANDARD.md"
        if Path(meta["path"]).name == "STANDARD.md"
        else f"{domain}.md"
    )
    header = _GENERATED_HEADER.format(source=source)
```

(This requires `meta` in `_render_skill`'s scope — it is already a parameter.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/skill_gen.test.ts -q`
Expected: PASS. (workspace_skills.test.ts will fail until Task 3 — that's expected; do not run the full suite yet.)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/lib/skill_gen.ts apps/cli/src/lib/__tests__/skill_gen.test.ts
git commit -m "feat(sandbox-cli): render standards skills as file bundles with references

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Bundle projection, prune, and staleness (`workspace_skills.ts`)

**Files:**
- Modify: `apps/cli/src/lib/workspace_skills.ts`
- Test: `apps/cli/src/lib/__tests__/workspace_skills.test.ts`

**Interfaces:**
- Consumes: `generate_skills(...) -> dict[str, dict[str, str]]` from Task 2.
- Produces:
  - `render_workspace_skills(...) -> dict[str, dict[str, str]]` — entry skills become `{"SKILL.md": content}` bundles.
  - `write_workspace_skills(...) -> list[Path]` — one path per file written (unchanged signature; callers in init_workspace.ts and skills.ts keep working).
  - `check_workspace_skills(...) -> list[str]` — drift strings now per-file: `missing: <name>/<relpath>`, `stale: <name>/<relpath>`, `orphaned: <name>` (whole dir) or `orphaned: <name>/<relpath>` (extra file inside a managed dir).

- [ ] **Step 1: Write the failing tests**

Open `apps/cli/src/lib/__tests__/workspace_skills.test.ts` and read its fixtures first (it builds `standards` and `entries` temp dirs). Update any fixture module to the flat form it already uses — flat modules keep working, so existing fixtures stand. Existing assertions on drift strings like `"missing: sb-x"` must become `"missing: sb-x/SKILL.md"` — update all such literals. Then append:

```node
def _dir_module_with_reference(standards: Path) -> None:
    refs = standards / "api" / "references"
    refs.mkdir(parents=True)
    (standards / "api" / "STANDARD.md").write_text(
        "---\ndomain: api\nsummary: API standard.\n---\n\n# API\n\n"
        "## Going deeper\n| When | Read |\n|---|---|\n"
        "| pagination | [references/pagination.md](references/pagination.md) |\n"
    )
    (refs / "pagination.md").write_text(
        "---\nkind: example\ncanonical: comx:apps/sb-web-api/src/main.ts\n---\n\n# P\n"
    )


def test_projection_writes_reference_files(tmp_path: Path):
    standards = tmp_path / "standards"
    standards.mkdir()
    _dir_module_with_reference(standards)
    entries = tmp_path / "entries"
    entries.mkdir()
    workspace = tmp_path / "ws"
    written = write_workspace_skills(workspace, standards, entries)
    skill_dir = workspace / ".claude" / "skills" / "sb-api-standard"
    assert (skill_dir / "SKILL.md").is_file()
    assert (skill_dir / "references" / "pagination.md").is_file()
    assert skill_dir / "references" / "pagination.md" in written
    assert check_workspace_skills(workspace, standards, entries) == []


def test_reference_only_edit_flags_stale(tmp_path: Path):
    standards = tmp_path / "standards"
    standards.mkdir()
    _dir_module_with_reference(standards)
    entries = tmp_path / "entries"
    entries.mkdir()
    workspace = tmp_path / "ws"
    write_workspace_skills(workspace, standards, entries)
    ref = standards / "api" / "references" / "pagination.md"
    ref.write_text(ref.read_text() + "\nMore.\n")
    drift = check_workspace_skills(workspace, standards, entries)
    assert drift == ["stale: sb-api-standard/references/pagination.md"]


def test_removed_reference_is_pruned_and_flagged(tmp_path: Path):
    standards = tmp_path / "standards"
    standards.mkdir()
    _dir_module_with_reference(standards)
    entries = tmp_path / "entries"
    entries.mkdir()
    workspace = tmp_path / "ws"
    write_workspace_skills(workspace, standards, entries)
    # Remove only the reference file. STANDARD.md keeps its (now dangling)
    # index link — rendering doesn't validate links, so SKILL.md content is
    # unchanged and the only drift is the orphaned projected reference.
    (standards / "api" / "references" / "pagination.md").unlink()
    drift = check_workspace_skills(workspace, standards, entries)
    assert drift == ["orphaned: sb-api-standard/references/pagination.md"]
    write_workspace_skills(workspace, standards, entries)
    skill_dir = workspace / ".claude" / "skills" / "sb-api-standard"
    assert not (skill_dir / "references").exists()
    assert check_workspace_skills(workspace, standards, entries) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -q`
Expected: FAIL — projection still treats bundles as strings (TypeError or content mismatch), before the new tests even run.

- [ ] **Step 3: Implement bundle projection**

In `apps/cli/src/lib/workspace_skills.ts`:

(a) `render_workspace_skills` — change the annotation to `dict[str, dict[str, str]]`, the docstring's first line to `"""Render every tr-* skill as {name: {relative-path: content}}."""`, and the entry-skill loop body to:

```node
            try:
                skills[skill_md.parent.name] = {"SKILL.md": skill_md.read_text()}
            except OSError:
                continue
```

(b) Replace the write-and-prune body of `write_workspace_skills` with:

```node
    rendered = render_workspace_skills(standards_dir, entry_skills_dir)
    target = workspace_skills_dir(workspace_root)
    written: list[Path] = []
    for name, bundle in sorted(rendered.items()):
        for relpath, content in sorted(bundle.items()):
            path = target / name / relpath
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.is_file() or path.read_text() != content:
                path.write_text(content)
            written.append(path)

    if target.is_dir():
        for entry in sorted(target.iterdir()):
            if not (entry.is_dir() and entry.name.startswith(_MANAGED_PREFIX)):
                continue
            if entry.name not in rendered:
                shutil.rmtree(entry)
                continue
            bundle = rendered[entry.name]
            for stray in sorted(entry.rglob("*.md")):
                if stray.relative_to(entry).as_posix() not in bundle:
                    stray.unlink()
            refs = entry / "references"
            if refs.is_dir() and not any(refs.iterdir()):
                refs.rmdir()
    return written
```

(c) Replace the comparison body of `check_workspace_skills` with:

```node
    rendered = render_workspace_skills(standards_dir, entry_skills_dir)
    target = workspace_skills_dir(workspace_root)
    errors: list[str] = []

    for name, bundle in sorted(rendered.items()):
        for relpath, content in sorted(bundle.items()):
            path = target / name / relpath
            if not path.is_file():
                errors.append(f"missing: {name}/{relpath}")
            elif path.read_text() != content:
                errors.append(f"stale: {name}/{relpath}")

    if target.is_dir():
        for entry in sorted(target.iterdir()):
            if not (entry.is_dir() and entry.name.startswith(_MANAGED_PREFIX)):
                continue
            if entry.name not in rendered:
                errors.append(f"orphaned: {entry.name}")
                continue
            for stray in sorted(entry.rglob("*.md")):
                rel = stray.relative_to(entry).as_posix()
                if rel not in rendered[entry.name]:
                    errors.append(f"orphaned: {entry.name}/{rel}")
    return errors
```

(d) Update the module docstring's "Two source kinds" paragraph: standards skills now render as file bundles (SKILL.md + references/) from docs/standards/ directories or flat files.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/workspace_skills.test.ts -q`
Expected: PASS.

- [ ] **Step 5: Run the whole CLI suite (first green point for the pipeline)**

Run: `npx vitest run apps/cli -q`
Expected: PASS — no other module consumes the old return type (`generate_skills` callers are workspace_skills.ts and skill_gen.test.ts only).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/lib/workspace_skills.ts apps/cli/src/lib/__tests__/workspace_skills.test.ts
git commit -m "feat(sandbox-cli): project standards skills as file bundles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire authoring invariants into `sandbox skills check`

**Files:**
- Modify: `apps/cli/src/commands/skills.ts`

**Interfaces:**
- Consumes: `validate_module_references()` from Task 2 (no-arg call loads the repo's real `docs/standards/`).
- Produces: `sandbox skills check` exits 1 when authoring invariants fail, with each error printed, in addition to the existing drift behavior. `sync` is unchanged.

- [ ] **Step 1: Implement (no new test file — the function is unit-tested in Task 2; this is a thin wiring change)**

In `apps/cli/src/commands/skills.ts`, add the import:

```node
from cli.lib.skill_gen import validate_module_references
```

and replace the check branch (everything from `drift = check_workspace_skills(workspace)` down) with:

```node
    authoring = validate_module_references()
    for entry in authoring:
        print(f"{Colors.RED}✗ {entry}{Colors.RESET}")

    drift = check_workspace_skills(workspace)
    for entry in drift:
        print(f"{Colors.RED}✗ {entry}{Colors.RESET}")
    if drift:
        print(
            f"{Colors.YELLOW}Workspace skills lag the sandbox repo — run "
            f"`sandbox skills sync` (or `sandbox init-workspace`) to refresh."
            f"{Colors.RESET}"
        )
    if authoring or drift:
        sys.exit(1)
    success("Workspace tr-* skills are current.")
```

- [ ] **Step 2: Verify by hand**

Run from the repo root: `node apps/cli/dist/main.js skills check`
Expected: exits 1 with "Not inside a sandbox workspace" (this repo is not a workspace) — confirming the command still parses and imports cleanly. Full behavior is covered by Task 2's unit tests plus existing command behavior.

Run: `npx vitest run apps/cli -q`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/commands/skills.ts
git commit -m "feat(sandbox-cli): enforce standards authoring invariants in skills check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Migrate the five modules to directory form

**Files:**
- Move: `docs/standards/{api,comments,data,graphql,ui}.md` → `docs/standards/<key>/STANDARD.md`

**Interfaces:**
- Consumes: dual-form discovery from Task 1 (so this is a pure `git mv` — no code changes).
- Produces: the tree Task 6 authors into. `docs/standards/repos/` is untouched.

- [ ] **Step 1: Move the modules**

```bash
cd /Users/jayboyer/workspace/sandbox
for key in api comments data graphql ui; do
  mkdir -p docs/standards/$key
  git mv docs/standards/$key.md docs/standards/$key/STANDARD.md
done
```

- [ ] **Step 2: Verify discovery and rendering still resolve all five domains**

Run: `npx vitest run apps/cli -q`
Expected: PASS — in particular `test_all_repo_modules_generate_a_skill`, which reads the real `docs/standards/` tree.

Cross-module links (e.g. `[comments.md](comments.md)` inside graphql) still rewrite to skill references because `_rewrite_links` matches on filename pattern + known domain, not on file location — confirm by running:

```bash
node -c "
from cli.lib.skill_gen import generate_skills
print(generate_skills()['sb-graphql-standard']['SKILL.md'])" | grep "sb-comments-standard"
```

Expected: at least one `` `sb-comments-standard` `` line. NOTE: after the move, a sibling-module link inside a STANDARD.md is written the same way as before (`comments.md`), even though the module now lives in `../comments/STANDARD.md` — the renderer resolves module links by domain name, not path. Do not "fix" the links to `../comments/STANDARD.md`; that form would fall through to a GitHub URL that doesn't exist.

- [ ] **Step 3: Commit**

```bash
git add -A docs/standards
git commit -m "refactor(standards): move modules to directory form (key/STANDARD.md)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Author the API module (proving ground)

**Files:**
- Rewrite: `docs/standards/api/STANDARD.md`
- Create: `docs/standards/api/references/pagination.md`
- Create: `docs/standards/api/references/error-contracts.md`
- Create: `docs/standards/api/references/ap-leaky-errors.md`
- Create: `docs/standards/api/references/ap-untyped-boundary.md`

**Interfaces:**
- Consumes: the rendering pipeline (Tasks 1–5). Content sources: the `nest-api` archetype services (per spec §6) at their local checkouts:
  - `~/workspace/comx/apps/sb-web-api` (NestJS — the primary source)
  - `~/workspace/taxonomy-service` (standalone)
  - `~/workspace/econx/apps/vendor-portal-server` (Express-style)
  - `~/workspace/econx/apps/sandbox-mcp`
- Produces: the finished proving-ground module; passes `validate_module_references()`.

- [ ] **Step 1: Research — mine the source repos**

This step produces `/private/tmp/claude-502/-Users-jayboyer-workspace-sandbox/4fe63fdf-7a41-493a-b893-f3b3d5d64b01/scratchpad/api-standard-research.md` (scratch, not committed) with findings per topic. For each topic, record: the convention observed, which repo/file demonstrates it best (exact path — this becomes the `canonical:` pointer), and any disagreement between repos.

Topics and where to look (adjust paths to what actually exists — these are starting points, verified to exist at plan time):

1. **Error/status contract** — in sb-web-api: `grep -rn "HttpException\|ExceptionFilter\|catch" ~/workspace/comx/apps/sb-web-api/src/app --include="*.ts" -l`; read any global exception filter and 2-3 controllers. What does a 404 return? A validation failure? Is there a shared error body shape?
2. **Pagination** — `grep -rln "cursor\|offset\|limit" ~/workspace/comx/apps/sb-web-api/src/app --include="*.controller.ts" --include="*.service.ts"`; identify the dominant convention (cursor vs offset, parameter names, response envelope).
3. **DTO validation at the boundary** — `grep -rln "class-validator\|ValidationPipe\|@Body()" ~/workspace/comx/apps/sb-web-api/src/app --include="*.ts" | head`; is `ValidationPipe` global (check `main.ts`)? Are DTOs classes with decorators?
4. **Resource naming** — list controller route strings: `grep -rn "@Controller(" ~/workspace/comx/apps/sb-web-api/src/app --include="*.ts"`; note plural/singular, kebab-case, nesting depth.
5. **Nullability (404 vs 200-null)** — read one findOne-style handler in each of sb-web-api and taxonomy-service; what happens on missing entity?
6. **Versioning posture** — `grep -rn "version\|/v[0-9]" ~/workspace/comx/apps/sb-web-api/src/app/**/*.controller.ts` and the main.ts prefix setup.

Where repos disagree, the *rule* records the chosen direction (prefer the sb-web-api convention unless it is clearly the outlier) and names which repo already does it right.

- [ ] **Step 2: Write STANDARD.md**

Rewrite `docs/standards/api/STANDARD.md` using this exact skeleton — frontmatter unchanged from the current placeholder except the summary; every `<...>` filled from Step 1 findings; body ≤ ~800 tokens:

```markdown
---
domain: api
applies_to:
  - "**/controllers/**"
  - "**/handlers/**"
  - "**/routes/**"
  - "**/*.controller.ts"
  - "**/*.service.ts"
phase: [implement, review]
summary: API standard — REST/Nest contract conventions, error/nullability contracts, pagination, DTO validation.
---

# API standard

The shared comment rubric ([comments.md](comments.md)) applies in full.

## Rules

- **Resource naming** — <convention from research: case, plurality, nesting>.
- **Status codes & error body** — <the shared error contract: shape, when 400/404/409/500>.
- **Pagination** — <the convention: parameter names, envelope, default/max page size>.
- **Validate at the boundary** — <DTO + ValidationPipe convention>.
- **Nullability contract** — <404 vs 200-null decision and when each applies>.
- **Versioning** — <the posture: URL prefix / header / none-yet, and what to do for breaking changes>.

## Don't

- Don't <leak internal errors — exact rule from research>; return the error contract — [references/ap-leaky-errors.md](references/ap-leaky-errors.md)
- Don't <accept untyped request bodies — exact rule>; declare a validated DTO — [references/ap-untyped-boundary.md](references/ap-untyped-boundary.md)

## Going deeper

| When you're doing | Read |
|---|---|
| adding pagination to a list endpoint | [references/pagination.md](references/pagination.md) |
| deciding what an endpoint returns on not-found / failure | [references/error-contracts.md](references/error-contracts.md) |
| writing catch blocks / exception filters | [references/ap-leaky-errors.md](references/ap-leaky-errors.md) |
| accepting a request body | [references/ap-untyped-boundary.md](references/ap-untyped-boundary.md) |
```

If research surfaces fewer than two genuine anti-patterns, write the ones that are real and delete the other planned `ap-` file from every list in this task — do not invent an anti-pattern to fill the skeleton.

- [ ] **Step 3: Write the two example references**

`docs/standards/api/references/pagination.md` — exact structure (fill from research):

```markdown
---
kind: example
canonical: <repo>:<path from research, e.g. comx:apps/sb-web-api/src/app/<x>/<x>.controller.ts>
---

# <Pagination convention name>

<3-6 lines: the rule being demonstrated, and why this implementation is the
canonical one (e.g. "most consumers", "newest convention", "the direction
chosen where repos disagree — <other repo> still does <old way>").>

## The load-bearing part

```ts
<~10-line excerpt copied verbatim from the canonical file — the signature,
the parameter handling, and the response envelope. Trim bodies to `…` where
they don't carry the convention.>
```

If this workspace has `<repo>` checked out, read the full canonical file
before writing your own.
```

`docs/standards/api/references/error-contracts.md` — same structure; canonical points at the exception filter / error-shaping code found in research; the excerpt shows the error body shape and one usage.

- [ ] **Step 4: Write the two anti-pattern references**

Structure for both (fill from research; a real incident reference is ideal but optional — never fabricate one):

```markdown
---
kind: anti-pattern
---

# <Anti-pattern name>

## What it looks like

```ts
<4-8 line negative example — realistic, minimal>
```

## Why it's wrong

<2-4 lines. If research or git history surfaced a real incident, cite it
(repo + PR/commit). Otherwise state the concrete failure mode.>

## The fix

```ts
<4-8 lines showing the compliant version, consistent with the rules in
STANDARD.md>
```
```

`ap-leaky-errors.md`: catch blocks that return raw error messages / stack traces to clients instead of the shared error contract.
`ap-untyped-boundary.md`: handlers accepting `any`/untyped bodies, skipping DTO validation.

- [ ] **Step 5: Validate and render**

```bash
node -c "
from cli.lib.skill_gen import validate_module_references
errs = validate_module_references()
print('\n'.join(errs) or 'OK')"
```
Expected: `OK`.

```bash
node -c "
from cli.lib.skill_gen import generate_skills
b = generate_skills()['sb-api-standard']
print(sorted(b)); print(b['SKILL.md'][:400])"
```
Expected: 5 files (`SKILL.md` + 4 references, or fewer if an ap- file was dropped in Step 2); SKILL.md shows the frontmatter + generated header.

Run: `npx vitest run apps/cli -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/standards/api
git commit -m "docs(standards): author API module — rules, examples, anti-patterns

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification

**Files:** none created (throwaway workspace under the scratchpad).

- [ ] **Step 1: Project into a scratch workspace and inspect**

```bash
SCRATCH=/private/tmp/claude-502/-Users-jayboyer-workspace-sandbox/4fe63fdf-7a41-493a-b893-f3b3d5d64b01/scratchpad/e2e-ws
node -c "
from pathlib import Path
from cli.lib.workspace_skills import write_workspace_skills, check_workspace_skills
ws = Path('$SCRATCH')
written = write_workspace_skills(ws)
print(len(written), 'files')
assert (ws / '.claude/skills/sb-api-standard/references/pagination.md').is_file()
assert check_workspace_skills(ws) == []
print('e2e OK')"
```
Expected: `e2e OK` and a file count ≥ 13 (9 skills + api references).

- [ ] **Step 2: Read the projected sb-api-standard SKILL.md as an agent would**

```bash
cat "$SCRATCH/.claude/skills/sb-api-standard/SKILL.md"
```
Check by eye: rules are terse; every "Don't" bullet links a references/ file; "Going deeper" links are relative (no github.com in that section); the generated header names `api/STANDARD.md` as the source.

- [ ] **Step 3: Clean up and run the full suite one last time**

```bash
rm -rf "$SCRATCH"
npx vitest run apps/cli -q
```
Expected: PASS.

- [ ] **Step 4: Commit anything outstanding (should be nothing)**

`git status` — expected clean. If not, stop and account for every unexpected file before committing.
