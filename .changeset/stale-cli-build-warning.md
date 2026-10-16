---
"@jbbz-sandbox/sandbox-cli": patch
---

A CLI linked from a checkout now warns on stderr when its `dist` bundle was built from a different commit than the checkout's `HEAD`. The warning names both SHAs and the rebuild command. Published installs and `sandbox hooks` skip the check.
