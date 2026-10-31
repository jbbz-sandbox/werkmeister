---
"werkmeister-core": patch
---

SW-236: `werkmeister machine setup` no longer leaves the host daemon (or the pr-watch agent) down when `launchctl bootstrap` races the bootout and fails with 5: it retries up to 5 times, 1 s apart. A re-run now bootstraps an agent whose plist is unchanged but isn't loaded, so "re-run to retry" works.
