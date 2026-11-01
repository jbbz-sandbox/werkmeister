---
"werkmeister-core": minor
"werkmeister": minor
---

SW-309: agents ask a person through Markdown forms. Each question in a form is a `## ` heading with `status: proposed`. Options are `- ( )` (pick one) or `- [ ]` (pick any), with `(recommended)`, `Other:`, and an empty `**Label:**` text box. `decisions.md` uses this syntax, every later ICM stage except propose ends by writing `output/question-approval.md`, and a question that comes up partway through a stage goes in `output/question-<slug>.md`, after which the agent stops. On the /workspaces pane, a workspace card with an open form shows `❓ <file> · N open`. Its Answer button opens the form inside the card as one sheet with one Submit. Submit writes the ticks and text back, changing only those lines and the `status:` line, refuses when the file changed after it was drawn, and asks the root session to relay "gate decided, continue". New in werkmeister-core: `parseForm`, `applyAnswers`, `formErrors`, `submitForm` and `openForms`. A `question-*.md` file never counts as a stage's output.
