---
"werkmeister": patch
---

The sandbox repo's `sandbox-install` setup service no longer reinstalls and rebuilds on every `up` (SW-33). It skips `npm ci` while the lockfile and Node major version match a stamp in the node_modules volume. The stamp is written only after a successful install, so a failed one retries. The service now mounts `~/repos` with `safe.directory`, so turbo restores the build from the main checkout's shared cache. At most `SANDBOX_INSTALL_SLOTS` (default 2) installs run at once host-wide, queued through `~/.sandbox/locks`. Run `werkmeister registry` after upgrading to pick up the new command; until then the old one runs unchanged.
