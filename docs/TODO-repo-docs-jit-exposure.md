# TODO: Expose repo-local docs to the JIT context system

Status: research needed — not started (parked 2026-07-12)
Context: review of econx in-repo docs vs the JIT standards pipeline
(jit-standards-loading-spec.md, standards content model).

## Problem

Valuable docs live inside service repos and are invisible to workspace agents:

- `econx/packages/ui/docs/` — 9 strategy docs (TOKEN_SYSTEM, TYPOGRAPHY, TESTING,
  CSS, SSR, RESPONSIVE, VERTICAL_RHYTHM, STORYBOOK_HELPERS, theming), 3–29KB each
- `econx/apps/web-v2/docs/CODEGEN.md`, `ga-events.md` — task-triggered procedures
- `econx/apps/vendor-portal-{server,client}/docs/` — orientation docs (architecture /
  data-flow / developer-guide / index); freshness UNVERIFIED, likely generated prose
- `econx/apps/federated-graph/docs/GATEWAY-HARDENING.md` — gateway change reference

Also: `econx/packages/ui/docs/codeSkills/` holds packaged skill zips
(econx-ui-component.zip, storybook-stories.zip) — a competing in-repo distribution
channel. Decide: kill or adopt; don't let it coexist silently.

## Direction settled during review (don't re-litigate)

**Point, never copy.** Repo-local docs are present iff relevant (the spec §7.1
content-in-body argument inverts for them), so they are the reference tier and
the JIT system carries only the routing map. Copies in docs/standards/ would rot
authoritatively. Docs stay owned/reviewed in econx PRs.

## Research tasks

1. **Wiring gap — repos/ snippet projection.** `standards.ts:37` excludes
   `docs/standards/repos/<repo>.md` from module loading; nothing in skill_gen.ts /
   claude_md.ts projects them into workspaces (they surface only as GitHub links
   from code-style-guide.md). Design how the matching snippets for the workspace's
   repos get projected: CLAUDE.md section vs generated `tr-<repo>-notes` skill.
   Consider size budget (snippets become always-on if inlined in CLAUDE.md).
2. **Routing table shape.** Draft a "Docs in this repo" Going-deeper-style table in
   `repos/econx.md` with workspace-relative pointers (e.g.
   `econx/packages/ui/docs/TOKEN_SYSTEM.md`). Decide row granularity + phase hints.
3. **Pointer validation.** Extend `validate_module_references` /
   `sandbox standards check` to resolve repo-doc pointers against canonical
   checkouts under the repos root, so dead links fail the check instead of rotting.
4. **Repo-qualified Going-deeper rows (maybe).** A `repo:` qualifier on domain
   STANDARD Going-deeper rows, filtered at projection time. Only build if a pointer
   genuinely belongs in a domain rather than a repo snippet — YAGNI until then.
5. **Doc grading pass.** Verify vendor-portal architecture/data-flow docs against
   code before exposing (stale orientation docs actively mislead agents). Expose
   index.md as entry point; hold or caveat the rest.
6. **Tier boundary.** Confirm repo docs never become a second rules channel:
   graduation pipeline stays the sole write path for rules; repo docs are the deep
   references those rules link to.

## Done means

Workspace agents in an econx workspace get JIT pointers to the relevant in-repo
docs (right phase, right task trigger), pointers are CI-validated, and no doc
content is duplicated into sandbox.
