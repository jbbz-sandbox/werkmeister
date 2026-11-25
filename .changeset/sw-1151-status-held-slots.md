---
"werkmeister": patch
---

SW-1151: `werkmeister feature status` and `statusSnapshot().summary.available_slots` now count free slots the way the slot allocator does. A slot leased to a workspace whose containers are stopped, not yet up or queued counts as held. Before, status counted only features with containers, so it could show 12 slots free while `feature up` found none.
