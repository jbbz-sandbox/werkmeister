---
"werkmeister": patch
---

SW-1232: `werkmeister pr status` leaves glob members of a changesets `fixed` group (such as `@acme/*`) out of `release_packages`, so a merged PR no longer waits forever on a tag for the glob and stays "partially released".
