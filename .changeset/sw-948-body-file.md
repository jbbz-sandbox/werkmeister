---
"werkmeister-core": patch
---

The generated issues guide says where an autonomous workspace's `werkmeister issue create --body-file` must live (SW-948): a file inside the workspace, not `-` (stdin) and not a scratchpad or temp path, which `issue create` refuses.
