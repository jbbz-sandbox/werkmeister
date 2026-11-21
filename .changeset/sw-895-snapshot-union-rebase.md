---
"werkmeister-core": patch
"werkmeister": patch
---

Rebasing a grouped branch whose per-ticket commits each change the JIT snapshot no longer stops at every step (SW-895). The snapshot is `merge=union` in a new `.gitattributes`, and pr-rules rule 5 and the werkmeister-core validate text name the rebase to run: `git rebase --autosquash <base> --exec '<build> && <regenerate> && git commit --amend --no-edit -a'`. The snapshot test now also fails a file that wasn't regenerated (a union-doubled line).
