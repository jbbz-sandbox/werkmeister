---
"@jbbz-sandbox/sandbox-cli": patch
---

The k8s port-forward container now retries the cluster check at startup and exits non-zero if it never succeeds, instead of sleeping forever. Sleeping disarmed the `restart: unless-stopped` policy, so losing the boot race against the cluster left every forward dead until someone restarted the container by hand.
