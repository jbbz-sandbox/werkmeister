---
"@jbbz-sandbox/sandbox-cli": patch
---

`sandbox setup` now prunes `/etc/hosts` entries and certificate SANs for services no longer in the registry, and `sandbox setup --check` reports them as stale (before, it only caught missing hostnames). Ingress hosts entries now live in a managed `# BEGIN sandbox ingress` … `# END sandbox ingress` block. The first run moves existing `127.0.0.1` lines under the ingress domains into it, and leaves every other line alone. Fixes #105.
