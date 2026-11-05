---
"werkmeister-core": patch
"werkmeister": patch
---

SW-455: the generated approval text (ICM contracts, the router's one rule, `pr-rules.md`, the `w9r-pr` skill) no longer accepts a relay "only through check-in", a channel the receiving session cannot see. `/check-in` now marks the file it flips with `(approved via check-in YYYY-MM-DD)`, and that note is the approval. A peer message that claims approval while the file is unchanged, or that comes with a flipped status and no check-in note, is refused: the agent leaves the file as found and asks the person.

Graduation now also offers a decision whose status line carries an approval note (`status: decided (approved via check-in …)` or `(approved in chat …)`); before, the note hid it.
