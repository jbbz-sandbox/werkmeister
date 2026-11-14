---
"werkmeister": patch
---

The werkmeister repo's install container puts `lsof` in the per-feature tools volume, and the `werkmeister-core` test row no longer installs it with `apt-get`, so the pre-approved test command a workspace's allow rules carry runs no package install on the host.
