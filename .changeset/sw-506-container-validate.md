---
"werkmeister-core": patch
---

SW-506: the host test step in the ICM implement contract yields to a service's own `docker exec` recipe; the werkmeister repo's cli `validate:` text now says to build, test and run `with-fixture-workspace` through `docker exec` after `feature up`.
