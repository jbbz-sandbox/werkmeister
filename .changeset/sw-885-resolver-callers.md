---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix reproduce contract's caller step now asks a fix to a shared root or path resolver to list every caller that writes or starts something outside the workspace (a daemon or launchd entry, a proxy config, shared infra, the tool's home folder) and settle how the change reaches each before the fix is decided (SW-885).
