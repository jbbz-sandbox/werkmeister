---
"@jbbz-sandbox/sandbox-cli": patch
---

claudeck is gone from this repo for good: `sandbox connect` no longer tries to start it (it lives in its own repo and starts itself), the `claudeck` self-host service is dropped from the sandbox registry fragment, and the `claudeck:sync` script moved with the folders merge into claudeck's workspace plugin.
