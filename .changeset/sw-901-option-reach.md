---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix reproduce and fix contracts now ask a permission-rule change to list each pre-approved command's options that reach outside the workspace, in every form the tool accepts (unique-prefix long options, bundled short flags, `--opt=value`), give each a deny, an exact rule or a recorded reason, and check each escape as a must-deny case under the real permission matcher (SW-901).
