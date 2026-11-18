---
"werkmeister-core": patch
---

An allocate inside a workspace container no longer prunes the other workspaces' leases: it sees only its own folder, so every other lease looked gone. Leases are pruned from the host only (SW-860).
