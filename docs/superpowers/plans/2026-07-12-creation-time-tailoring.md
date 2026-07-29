# Creation-Time Tailoring (work_type) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `work_type` field (`feature|bugfix|refactor|spike|incident`, default `feature`) to workspace creation whose single effect is seeding a work-type-aware first-phase handoff note.

**Architecture:** One new `PromptSpec` in `_WIZARD_PROMPTS` (all three form surfaces derive from it automatically), one resolution-tuple entry, two argparse flags, one flag-forwarding entry, and an extended seed function driven by a `WORK_TYPE_PHASES` code constant. Spec: `docs/superpowers/specs/2026-07-12-creation-time-tailoring-design.md`.

**Tech Stack:** Node 20+, vitest via uv. No JS/TS changes (`form_schema.ts` already renders single-choice enums; `buildWorkspaceArgs` in the node app maps formData keys to kebab flags generically).

## Global Constraints

- Branch: `multi-feature` (permanent; never merges to `main`).
- Run tests from the repo root: `npx vitest run apps/cli/src/lib/__tests__/<file> -q`.
- Conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Known pre-existing failure (NOT ours; do not fix): `secrets_check.test.ts::test_required_secret_keys_matches_env_j2_set`.
- Work-type values, exactly: `feature`, `bugfix`, `refactor`, `spike`, `incident`. Mapping: refactor → `implement`/`sb-implement`; all others → `research`/`sb-research`.
- Do NOT touch: `apps/cli/src/lib/form_schema.ts`, `apps/mcp-workspace/`, `apps/cli/src/lib/claude_md.ts`, `apps/cli/src/lib/standards.ts`, `infra/skills/`.

---

### Task 1: work_type constant + PromptSpec + resolution + single-select wizard fixes

**Files:**
- Modify: `apps/cli/src/commands/init_workspace.ts` (constants near line 460, `_WIZARD_PROMPTS` line 462, `_INPUT_FIELDS` line 153, `_prompt_one` line 540, `_run_interactive_wizard` line 577)
- Test: `apps/cli/src/lib/__tests__/workspace.test.ts`

**Interfaces:**
- Produces: `WORK_TYPE_PHASES: dict[str, tuple[str, str]]` (work type → `(phase, entry-skill sentence)`) and `WORK_TYPES: tuple[str, ...]` in `cli.commands.init_workspace`; a `work_type` key in `_resolve_inputs` output. Task 3 consumes `WORK_TYPE_PHASES`; Task 2 consumes the resolved `work_type`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/lib/__tests__/workspace.test.ts` (it already imports `Namespace`, `resolve_workspace_inputs`, and has `_ws_args`/`_write_config` helpers around lines 80–92):

```node
# --- work_type (creation-time tailoring spec §3) ----------------------------

def test_work_type_prompt_spec_shape():
    from cli.commands.init_workspace import _WIZARD_PROMPTS, WORK_TYPES
    assert WORK_TYPES == ("feature", "bugfix", "refactor", "spike", "incident")
    spec = next(p for p in _WIZARD_PROMPTS if p.key == "work_type")
    assert spec.choices_fn() == list(WORK_TYPES)
    assert spec.accept_empty is False          # default stands in; always recorded
    assert spec.default_fn(Path("/anywhere")) == "feature"
    keys = [p.key for p in _WIZARD_PROMPTS]
    assert keys.index("work_type") == keys.index("feature") + 1


def test_work_type_renders_as_required_enum_with_default(tmp_path):
    from cli.commands.init_workspace import _WIZARD_PROMPTS, _prompt_entry
    from cli.lib.form_schema import build_form_schema
    spec = next(p for p in _WIZARD_PROMPTS if p.key == "work_type")
    entry = _prompt_entry(spec, tmp_path, {})
    out = build_form_schema({"workspace_name": "w", "prompts": [entry]})
    prop = out["schema"]["properties"]["work_type"]
    assert prop["enum"] == ["feature", "bugfix", "refactor", "spike", "incident"]
    assert out["formData"]["work_type"] == "feature"
    assert "work_type" in out["schema"]["required"]


def test_work_type_resolves_env_over_config(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    _write_config(tmp_path, feature="f", work_type="refactor")
    resolved = resolve_workspace_inputs(_ws_args())
    assert resolved["work_type"] == "refactor"
    monkeypatch.setenv("SANDBOX_WORK_TYPE", "spike")
    resolved = resolve_workspace_inputs(_ws_args())
    assert resolved["work_type"] == "spike"  # env outranks config


def test_prompt_one_single_select_rejects_typo_then_accepts(monkeypatch):
    # Regression: _prompt_one used to run _normalize_services on ANY choices
    # field, silently blanking a single-select typo. It must retry instead.
    from cli.commands import init_workspace as iw
    spec = next(p for p in iw._WIZARD_PROMPTS if p.key == "work_type")
    answers = iter(["bugfx", "bugfix"])
    monkeypatch.setattr(iw, "_prompt", lambda label, default: next(answers))
    assert iw._prompt_one(spec, "feature", spec.choices_fn()) == "bugfix"
```

If `workspace.test.ts` doesn't already import `Path` at the top, add `from pathlib import Path` to its imports.

- [ ] **Step 2: Run tests to verify they fail**

Run (repo root): `npx vitest run apps/cli/src/lib/__tests__/workspace.test.ts -q -k "work_type or prompt_one"`
Expected: 4 FAILED — `ImportError: cannot import name 'WORK_TYPES'` / `StopIteration: no work_type prompt`.

- [ ] **Step 3: Implement in `init_workspace.ts`**

3a. Add the constants immediately after the `PromptSpec` dataclass (after line 459, before `_WIZARD_PROMPTS`):

```node
# Work type → (seeded note phase, first entry-skill sentence). The one
# creation-time signal not derivable from services/archetypes; consumed only
# by the starting-handoff seeder (creation-time-tailoring spec §2/§4).
WORK_TYPE_PHASES: dict[str, tuple[str, str]] = {
    "feature": ("research", "invoke `sb-research` first to explore and spec the work"),
    "bugfix": ("research", "invoke `sb-research` first to reproduce and locate "
                           "the root cause before changing code"),
    "refactor": ("implement", "invoke `sb-implement` first — the scope is known "
                              "and standards matter most"),
    "spike": ("research", "invoke `sb-research` first to frame the questions "
                          "this spike must answer"),
    "incident": ("research", "invoke `sb-research` first to diagnose before "
                             "changing anything"),
}
WORK_TYPES: tuple[str, ...] = tuple(WORK_TYPE_PHASES)
```

3b. Insert a new `PromptSpec` into `_WIZARD_PROMPTS` directly AFTER the `feature` entry (after line 475):

```node
    PromptSpec(
        key="work_type",
        label="Work type",
        help="What kind of work this is; seeds the first-phase handoff note "
             "(research vs implement) for the workspace's first session.",
        accept_empty=False,
        pattern=r"^(" + "|".join(WORK_TYPE_PHASES) + r")$",
        default_fn=lambda ws: "feature",
        choices_fn=lambda: list(WORK_TYPES),
    ),
```

(Note: `WORK_TYPE_PHASES` must be defined above `_WIZARD_PROMPTS` for the pattern join.)

3c. Add to `_INPUT_FIELDS` (line 153), after the `feature` entry:

```node
    ("work_type", "SANDBOX_WORK_TYPE", "work_type"),
```

3d. Fix `_prompt_one` (line ~549): change

```node
        if choices and value:
            value = _normalize_services(value, choices)
```

to

```node
        if spec.multi and choices and value:
            value = _normalize_services(value, choices)
```

3e. Generalize the wizard's choices banner in `_run_interactive_wizard` (line ~577): change

```node
        if choices:
            info("  Available services: " + ", ".join(choices))
```

to

```node
        if choices:
            info("  Choices: " + ", ".join(choices))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/workspace.test.ts -q`
Expected: all pass (new 4 + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/init_workspace.ts apps/cli/src/lib/__tests__/workspace.test.ts
git commit -m "feat(sandbox-cli): work_type wizard field + resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: --work-type argparse flags + workspace flag forwarding

**Files:**
- Modify: `apps/cli/src/main.ts` (workspace parser ~line 386, init-workspace parser ~line 459)
- Modify: `apps/cli/src/commands/workspace.ts:496-506` (`_init_workspace_flags` tuple)
- Test: `apps/cli/src/lib/__tests__/workspace.test.ts`

**Interfaces:**
- Consumes: the resolved `work_type` key from Task 1.
- Produces: `--work-type` accepted by both `sandbox workspace` and `sandbox init-workspace`; `_init_workspace_flags` emits `["--work-type", <value>]` when resolved. (The node form's `buildWorkspaceArgs` already kebab-cases `work_type` → `--work-type`, so form submissions start working with this task.)

- [ ] **Step 1: Write the failing test**

Append to `workspace.test.ts`:

```node
def test_init_workspace_flags_forwards_work_type():
    flags = _init_workspace_flags("f", {"work_type": "spike"})
    assert "--work-type" in flags and "spike" in flags
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/src/lib/__tests__/workspace.test.ts::test_init_workspace_flags_forwards_work_type -q`
Expected: FAIL — `assert '--work-type' in [...]`.

- [ ] **Step 3: Implement**

3a. `workspace.ts` — in `_init_workspace_flags` (line ~496), add to the key/flag tuple after the `starting_prompt` entry:

```node
        ("work_type", "--work-type"),
```

3b. `main.ts` — after the workspace parser's `--starting-prompt` block (line ~386), add:

```node
    p_workspace.add_argument(
        "--work-type", default=None, dest="work_type",
        choices=["feature", "bugfix", "refactor", "spike", "incident"],
        help="Kind of work; seeds the first-phase handoff note. Passed through "
             "to init-workspace.",
    )
```

3c. `main.ts` — after the init-workspace parser's `--starting-prompt` block (line ~459), add:

```node
    p_init_workspace.add_argument(
        "--work-type", default=None, dest="work_type",
        choices=["feature", "bugfix", "refactor", "spike", "incident"],
        help="Kind of work; seeds the first-phase handoff note "
             "(env: SANDBOX_WORK_TYPE; config: work_type).",
    )
```

(Literal choices in main.ts, not an import of `WORK_TYPES` — main.ts builds parsers without importing command modules; keep it that way.)

- [ ] **Step 4: Run tests + smoke-check the parsers**

Run: `npx vitest run apps/cli/src/lib/__tests__/workspace.test.ts -q`
Expected: all pass.

Run: `node apps/cli/dist/main.js workspace --help | grep -A2 work-type` from `apps/cli/`
Expected: the `--work-type {feature,bugfix,refactor,spike,incident}` option renders.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/main.ts apps/cli/src/commands/workspace.ts apps/cli/src/lib/__tests__/workspace.test.ts
git commit -m "feat(sandbox-cli): --work-type flag on workspace + init-workspace

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: work-type-aware starting-handoff seeding

**Files:**
- Modify: `apps/cli/src/commands/init_workspace.ts:1097-1139` (seed function) and the call site at line ~1269
- Test: `apps/cli/src/lib/__tests__/notes.test.ts` (existing seed tests, lines 190-243)

**Interfaces:**
- Consumes: `WORK_TYPE_PHASES` from Task 1; resolved `work_type` from `inputs`.
- Produces: `_seed_starting_handoff(workspace_root: Path, starting_prompt: str, work_type: str) -> None` (renamed from `_seed_starting_prompt_handoff`; notes.test.ts imports it by name at line 19).

- [ ] **Step 1: Rewrite the seed tests (failing first)**

In `notes.test.ts`, change the import (line 19) from `_seed_starting_prompt_handoff` to `_seed_starting_handoff`, then replace the four tests in the "Starting-prompt seeding" section (lines 197-242) with:

```node
def test_seed_writes_first_handoff_note(tmp_path: Path) -> None:
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "feature")

    note = latest_handoff(tmp_path)
    assert note is not None
    assert note["path"].name == "001-handoff-starting-prompt.md"
    assert note["frontmatter"]["author"] == "workspace-creation"
    assert note["frontmatter"]["status"] == "open"
    assert note["frontmatter"]["phase"] == "research"
    assert "This workspace is a feature" in note["body"]
    assert "sb-research" in note["body"]
    assert _STARTING_PROMPT in note["body"]
    # HITL framing: state, not an instruction to auto-execute
    assert "has not begun" in note["body"]
    assert "confirm" in note["body"]


def test_seed_refactor_maps_to_implement_phase(tmp_path: Path) -> None:
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "refactor")
    note = latest_handoff(tmp_path)
    assert note["frontmatter"]["phase"] == "implement"
    assert "sb-implement" in note["body"]


def test_seed_minimal_note_without_prompt(tmp_path: Path) -> None:
    # work_type alone seeds a minimal note (spec §2 decision 5): phase
    # direction, no task, so no confirm-direction sentence.
    _seed_starting_handoff(tmp_path, "", "spike")
    note = latest_handoff(tmp_path)
    assert note is not None
    assert note["frontmatter"]["phase"] == "research"
    assert "This workspace is a spike" in note["body"]
    assert "confirm" not in note["body"]


def test_seed_skips_when_no_inputs(tmp_path: Path) -> None:
    # Legacy no-input init (direct `sandbox init-workspace --feature x`):
    # nothing to seed.
    _seed_starting_handoff(tmp_path, "", "")
    _seed_starting_handoff(tmp_path, "   ", "  ")
    assert list_notes(tmp_path) == []


def test_seed_unknown_work_type_falls_back_to_research(tmp_path: Path) -> None:
    # Hand-edited workspace.yml with a bogus value must not error (spec §6).
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "banana")
    note = latest_handoff(tmp_path)
    assert note["frontmatter"]["phase"] == "research"
    assert "sb-research" in note["body"]


def test_seed_skips_when_any_handoff_exists(tmp_path: Path) -> None:
    # An open handoff (in-flight state) blocks seeding...
    _write_note(notes_dir(tmp_path), "001-handoff-session-end.md", "handoff")
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "feature")
    assert len(list_notes(tmp_path, include_superseded=True)) == 1

    # ...and so does a superseded one: a retired starting prompt must never
    # resurrect on re-init.
    (notes_dir(tmp_path) / "001-handoff-session-end.md").unlink()
    _write_note(notes_dir(tmp_path), "001-handoff-starting-prompt.md", "handoff",
                status="superseded")
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "feature")
    assert len(list_notes(tmp_path, include_superseded=True)) == 1


def test_seed_is_idempotent(tmp_path: Path) -> None:
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "feature")
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "feature")  # re-run init
    assert len(list_notes(tmp_path)) == 1


def test_seed_coexists_with_non_handoff_notes(tmp_path: Path) -> None:
    # Salvaged contract / decision notes don't imply the task started.
    _write_note(notes_dir(tmp_path), "001-contract-migrated-handoff-notes.md", "contract")
    _seed_starting_handoff(tmp_path, _STARTING_PROMPT, "feature")
    note = latest_handoff(tmp_path)
    assert note is not None
    assert note["path"].name == "002-handoff-starting-prompt.md"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -q`
Expected: collection error — `ImportError: cannot import name '_seed_starting_handoff'`.

- [ ] **Step 3: Implement the seed function**

Replace `_seed_starting_prompt_handoff` (init_workspace.ts lines 1097-1139) with:

```node
def _seed_starting_handoff(
    workspace_root: Path, starting_prompt: str, work_type: str,
) -> None:
    """Seed the workspace's first handoff note from creation-time inputs.

    A starting prompt is a handoff from the workspace creator to the first
    session — seeding it as a `handoff` note gives it the whole notes-layer
    machinery (SessionStart injection, entry-skill reads, `sandbox down`
    printing) with no special casing, and the first real `sb-handoff`
    supersedes it naturally (jit-notes-and-handoffs-spec.md §4.5).

    The work type sets the note's `phase:` and names the entry skill to
    invoke first (WORK_TYPE_PHASES; creation-time-tailoring spec §4). A
    work type without a prompt seeds a minimal direction-only note; neither
    input → nothing to seed (legacy no-input init).

    Write-once: seeded only while the workspace has no handoff note of ANY
    status — a superseded starting prompt must never resurrect on re-init,
    and in-flight state always outranks the creation-time snapshot. Editing
    workspace.yml later does not update the note. Failures only warn:
    seeding must never block init.
    """
    prompt = starting_prompt.strip()
    wt = work_type.strip().lower()
    if not prompt and not wt:
        return
    phase, first_skill = WORK_TYPE_PHASES.get(
        wt, ("research", "invoke `sb-research` first"),
    )
    try:
        directory = notes_dir(workspace_root)
        existing = list_notes(workspace_root, include_superseded=True)
        if any(note["type"] == "handoff" for note in existing):
            return
        directory.mkdir(parents=True, exist_ok=True)
        filename = note_filename(
            next_note_number(directory), "handoff", "starting-prompt"
        )
        lines = [
            "---",
            "type: handoff",
            f"phase: {phase}",
            "author: workspace-creation",
            "refs: []",
            "status: open",
            "---",
            "",
            "# Handoff: workspace creation",
            "",
        ]
        if wt:
            lines += [f"This workspace is a {wt} — {first_skill}.", ""]
        if prompt:
            lines += [
                "Seeded from `starting_prompt` in .sandbox/workspace.yml when the",
                "workspace was created. The task below has not begun — confirm",
                "direction with the user before executing it.",
                "",
                prompt,
            ]
        else:
            lines += ["Seeded at workspace creation (no starting prompt was provided)."]
        (directory / filename).write_text("\n".join(lines) + "\n")
        success(f"Seeded starting handoff → .sandbox/notes/{filename}")
    except OSError as exc:
        warn(f"Could not seed starting handoff: {exc}")
```

Update the call site (line ~1269) from:

```node
    _seed_starting_prompt_handoff(workspace_root, inputs.get("starting_prompt", ""))
```

to:

```node
    _seed_starting_handoff(
        workspace_root,
        inputs.get("starting_prompt", ""),
        inputs.get("work_type", ""),
    )
```

Also update the comment two lines above the call site: "then the starting prompt is seeded" → "then the starting prompt / work type is seeded".

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/notes.test.ts -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/init_workspace.ts apps/cli/src/lib/__tests__/notes.test.ts
git commit -m "feat(sandbox-cli): work-type-aware first-phase handoff seeding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Full suite + handoff doc update

**Files:**
- Modify: `docs/jit-content-HANDOFF.md` (sub-project table row 3, "Suggested next-session order")

**Interfaces:**
- Consumes: everything above.
- Produces: green suite (minus the one known pre-existing failure) and an updated workstream handoff.

- [ ] **Step 1: Run the full CLI test suite**

Run: `npx vitest run apps/cli -q`
Expected: all pass EXCEPT the known pre-existing `secrets_check.test.ts::test_required_secret_keys_matches_env_j2_set` (see Global Constraints). Any other failure = fix before proceeding.

- [ ] **Step 2: End-to-end smoke (optional but cheap)**

From the repo root: `./sandbox workspace --print-form-schema 2>/dev/null | jq '.schema.properties.work_type.enum, .formData.work_type'`
Expected: `['feature', 'bugfix', 'refactor', 'spike', 'incident'] feature`

- [ ] **Step 3: Update the workstream handoff doc**

In `docs/jit-content-HANDOFF.md`:
- Table row 3 status → `spec + plan DONE; EXECUTED <date>` (use the actual date).
- Add a "Sub-project 3 artifacts" section mirroring sub-project 2's, pointing at
  `docs/superpowers/specs/2026-07-12-creation-time-tailoring-design.md` and
  `docs/superpowers/plans/2026-07-12-creation-time-tailoring.md`, noting the key
  settled decisions (one work_type field, default feature always recorded,
  single effect = seeding, mapping constant in init_workspace.ts).
- Update "Suggested next-session order": next design target is #4 authoring
  pipeline; #1's plan remains executable whenever convenient.

- [ ] **Step 4: Commit**

```bash
git add docs/jit-content-HANDOFF.md
git commit -m "docs: mark creation-time tailoring executed in phase-2 handoff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
