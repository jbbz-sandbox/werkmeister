# GKE dev interception (`sandbox intercept`)

Routes a header-scoped slice of live dev-cluster traffic
(`gke_tr-dev-361214_us-central1_tr-dev-gke`) to a feature's local service via
Telepresence OSS. Additive to the compose path — `sandbox up` still runs the
service locally; interception points real cluster traffic at that container.

## Prerequisites
- Telepresence OSS >= 2.30 by **direct release download** — the
  `datawire/blackbird` brew tap ships only 2.19.x (too old for ambient) and has
  no `-oss` formula (`sandbox setup` reports the installed version):
  ```
  curl -fL https://github.com/telepresenceio/telepresence/releases/latest/download/telepresence-darwin-arm64 \
    -o /opt/homebrew/bin/telepresence && chmod +x /opt/homebrew/bin/telepresence
  ```
- The service must have `gke_deployment`, `gke_namespace`, `gke_port`, and
  `gke_port_name` in `infra/config/services.yaml`. `gke_port_name` exists only for
  services whose k8s Service uses a NAMED targetPort — the Istio-ambient
  precondition (telepresenceio/telepresence#3990); `gke_port` (the number) is the
  telepresence `--port` identifier. Audit table: docs/gke-intercept-spike.md.
- The feature must be up: `sandbox up <feature> -s <service>`.

## Usage
    sandbox intercept <feature> -s <service>     # start (filter: x-feature=<feature>)
    sandbox intercept <feature> --leave -s <svc> # end one
    sandbox intercept <feature> --leave          # end all for the feature
    sandbox intercept --status                   # daemon + intercept status
    # `sandbox down <feature>` also leaves the feature's intercepts.

Exercise it by sending requests to the intercepted service's **own** dev
ingress host with the `x-feature: <feature>` header — e.g. web-v2 is
`https://web-v2.dev.sandbox.com/` (its HTTPRoute hostname), NOT the shared
`sb-web.*` host, which routes to a different app and won't divert. Requests
without the header keep hitting the normal dev deployment — teammates are
unaffected. (Note: curling the in-cluster Service DNS from your own connected
machine always routes local regardless of header; only an external client
exercises the header filter.)

## Scope

Both answers below are **confirmed** by the Phase-0 spike (docs/gke-intercept-spike.md).

**Connect mode: host mode (the code default).** The intercept target is a
host-published slot port (`localhost:<slot-port>`, the container `sandbox up`
publishes), and only host mode maps the intercept to the **host's** loopback.
`--docker-daemon` (`connect --docker`) connects fine but maps the intercept to
the **daemon container's** loopback, which cannot reach a host-published port —
so it is NOT a drop-in fallback for the sandbox model (it would require running
the local service as a container on telepresence's network via `--docker-run`).
Host mode needs the telepresence root daemon, which on macOS asks for sudo once
to install a launchd service (telepresence 2.27+) — accept that prompt the first
time you intercept.

**Services in scope for v1: edge services only (e.g. web-v2).** Deep services
(e.g. product-api) are deferred — the `x-feature` header is not yet propagated
through federated-graph to the deep subgraphs in dev, so a deep intercept would
match nothing. They become interceptable once the `x-feature-propagation`
workspace ships gateway→subgraph header propagation to dev.

## Troubleshooting
- "connection reset"/503 through the intercept → the Service's targetPort is
  numeric; fix the manifest and add `gke_port_name` (ambient iptables conflict).
- Host-mode connect fails to launch the root daemon → accept the one-time sudo
  prompt (launchd install, telepresence 2.27+). `--docker-daemon` avoids the root
  daemon/host TUN device, but it cannot reach the host slot port (see Scope) — use
  it for connectivity checks, not for slot intercepts.
- Intercept matches nothing on a deep service → the header isn't propagated
  that far yet; see Scope above.
- Root daemon password prompt on macOS → one-time launchd service install
  (telepresence 2.27+), or use `--docker-daemon`.
