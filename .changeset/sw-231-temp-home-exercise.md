---
"werkmeister-core": patch
---

SW-231: the generated `werkmeister-context.md` tells the exercise step to start each command with the `with-temp-home` script (`with-temp-home env WERKMEISTER_ROOT=… <cmd>`) and names the allow rule `Bash(<script>:*)` that covers it, so a permission rule can match.
