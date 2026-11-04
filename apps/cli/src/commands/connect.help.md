## Description

**`--k8s`** starts or checks only the containerized k8s port-forwards. Starts the `k8s-forwards` Docker container (part of `infra/compose/shared-infra.yml`), which runs one `kubectl port-forward` process per entry in the generated forwards table, all inside a single container. If the container is already healthy, the command says so and does nothing.

The container runs on the `werkmeister-shared` Docker network and is accessible to other containers via the DNS name `k8s-forwards`. Port-forward processes inside the container auto-restart if they disconnect, managed by the container's entrypoint script.

```
=== k8s Connect ===

[info] Attempting to start/restart k8s-forwards container...
[ok]   k8s port-forwards started
```

If the forwards can't be started, it prints `Failed to start k8s port-forwards.` and points at Docker and your kubeconfig. `werkmeister infra status` lists each forward and whether it is alive.

Without `--k8s`, it starts all shared infrastructure, waits up to 90 seconds for it to settle, then prints a health summary (`caddy`, `k8s-forwards` and any opted-in tools), the issue-tracker check, and the developer-tool links:

```
=== Werkmeister Connect ===

--- Health Summary ---

  caddy                          healthy
  k8s-forwards                   healthy

  All 2 services healthy
```
