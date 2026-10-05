---
name: sb-handoff
description: "Write a handoff note capturing session/phase state in a sandbox workspace. Use when pausing or ending a session, when the user says 'hand off', 'wrap up', 'pause here', or between phases (research done → implementation next) — any moment the current window's state must survive into a later session or agent."
---

# sb-handoff — checkpoint the session into a handoff note

Write one `handoff` note to `.sandbox/notes/` so a fresh session can resume without
re-deriving state. Conventions: docs/notes-conventions.md in the sandbox repo.

1. **Supersede the previous handoff.** If a non-superseded `handoff` note exists in
   `.sandbox/notes/`, edit its frontmatter to `status: superseded`. Do not delete it.
2. **Write the new note** as `.sandbox/notes/NNN-handoff-<slug>.md` — next free `NNN`,
   slug like `2026-07-04-session-end` or `research-to-implement`:

   ```yaml
   ---
   type: handoff
   phase: research | implement | test | review   # the phase being exited
   author: main
   refs: [<files / services the in-flight work touches>]
   status: open
   ---
   ```

   Body — four sections, each concrete enough to act on without this conversation:

   - **Done** — what shipped/settled this session, with `file:line` or note refs.
   - **In-flight** — work started but unfinished: exact state, next concrete edit.
   - **Next** — the ordered next actions a resuming session should take.
   - **Open questions** — unresolved decisions or ambiguities, and who can answer them.

3. **Don't duplicate other note types.** A decision that settled or an approach that
   failed this session belongs in its own `decision` / `attempt` note (write it now if
   it's missing); the handoff *references* those notes rather than restating them.
4. **Confirm to the user**: the note path and a one-line summary of what a fresh
   session will pick up.

If `.sandbox/notes/` does not exist (not a sandbox-initialized workspace), create the
directory first.
