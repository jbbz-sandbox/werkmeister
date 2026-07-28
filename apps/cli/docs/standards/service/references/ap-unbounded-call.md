---
kind: anti-pattern
canonical: "sandbox:infra/compose/gke-port-forward/entrypoint.sh"
---

# An outbound call with no timeout, inside a retry loop

## What it looks like

```bash
# find the pod, forever if the API server is slow
find_pod() {
  kubectl get pods -n "$namespace" \
    --field-selector=status.phase=Running \
    -l "$selector" -o jsonpath='{.items[0].metadata.name}'
}
while true; do
  pod=$(find_pod "$ns" "$prefix")   # no timeout — hangs here
  kubectl port-forward "$pod" ...
done
```

## Why it's wrong

Real code: `sandbox:infra/compose/gke-port-forward/entrypoint.sh`.
When a spot GKE node is preempted, a `kubectl` call with no `--request-timeout`
blocks indefinitely against the unreachable API server. The enclosing
`while true` retry subshell never comes back around, so the forward dies
silently — the log file just stops updating. An unbounded blocking call inside
a loop is not a slow path; it is a silent-death bug.

## The fix

Bound every `kubectl` call with `--request-timeout`, so a stuck API server
surfaces as a fast error the loop can retry instead of a hang. The fixed code
(`entrypoint.sh`) carries `--request-timeout=10s` on `find_pod`'s
`kubectl get pods`, the deployment lookup, and the `cluster-info` preflight:

```bash
kubectl get pods -n "$namespace" \
  --field-selector=status.phase=Running --request-timeout=10s \
  -l "$selector" -o jsonpath='{.items[0].metadata.name}'
```
