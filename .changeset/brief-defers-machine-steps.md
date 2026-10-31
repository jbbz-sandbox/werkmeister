---
"werkmeister": patch
---

A workspace's `starting_prompt` (distilled from the ticket) and its autonomous `BRIEF.md` no longer list machine-writing steps (`werkmeister registry sync`, `werkmeister infra proxy-reload`, `npm link`, global installs) as run steps; they move to an `## After merge` note, so the brief no longer contradicts its run limits (SW-296).
