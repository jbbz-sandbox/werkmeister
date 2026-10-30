## Description

**`--k8s`** starts or checks only the containerized k8s port-forwards. Starts the `k8s-forwards` Docker container (part of `infra/compose/shared-infra.yml`) which runs all 12 `kubectl port-forward` processes (9 application + 3 infrastructure) inside a single container. If the container is already running, the command checks its health status.

The container runs on the `werkmeister-shared` Docker network and is accessible to other containers via the DNS name `k8s-forwards`. Port-forward processes inside the container auto-restart if they disconnect, managed by the container's entrypoint script.

After starting, it runs a health check and reports the status.

```
[info] Starting k8s-forwards container...
[ok]   k8s-forwards container is healthy. 12/12 forwards active.
```
