---
"werkmeister": patch
"werkmeister-core": patch
---

`with-fixture-workspace` and `withFixtureWorkspace` point the dead daemon address (`WERKMEISTER_HOST`) at a port just bound and closed, instead of `127.0.0.1:1`, which fetch rejects as a "bad port" (a TypeError with no `cause.code`) before connecting. A fixture run now sees a refused connection (`ECONNREFUSED`), as with a real stopped daemon, so the refused, restart and fallback paths can be exercised through the fixture.
