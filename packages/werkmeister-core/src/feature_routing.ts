/**
 * Feature routing, sourced from services.yaml + the ingress config.
 *
 * Caddy terminates a service's public hostname directly and reverse-proxies to
 * the running container. When
 * an `X-Feature` cookie is present, Caddy copies its value into an `X-Feature`
 * header on the upstream call so the app can read the selected feature.
 *
 * A service opts into routing by declaring a `feature_router:` block in
 * services.yaml. Hostnames DERIVE from the base domains in
 * `~/.werkmeister/config.yaml` rather than being restated per service:
 *
 *   ingress:                        # ~/.werkmeister/config.yaml
 *     local_domain: local.werkmeister.io
 *     remote_domain: remote.werkmeister.io
 *
 *   frontend:                     # ~/.werkmeister/services.yaml
 *     feature_router:
 *       remote_upstream: k8s-frontend:9053
 *
 * yields `frontend.local.werkmeister.io` (local docker feature) and
 * `frontend.remote.werkmeister.io` (the cluster deployment). A service that
 * needs a non-conforming host pins it explicitly with `hostname:` /
 * `remote_hostname:`, which always wins over the derived value.
 *
 * One derivation, three consumers: the Caddyfile generator (`generate.ts`)
 * builds a site block per hostname, `bin/generate-certs.sh` puts the same list
 * in the certificate SANs, and `/etc/hosts` points them all at 127.0.0.1.
 * `ingressHostnames()` is what keeps those three in agreement — before this,
 * the cert script hardcoded a hostname list that had to be hand-synced with
 * the registry.
 */

import { loadServices, type ServicesConfig } from "./config.js";
import { type IngressSettings, loadIngress } from "./global_config.js";

export interface FeatureRouter {
  /** Public host Caddy terminates for the local docker feature. */
  hostname?: string;
  /**
   * k8s baseline (`k8s-forwards:<port>`); absent for local-only services.
   *
   * TODO(routing): dead field — nothing in services.yaml sets `k8s:` and no
   * consumer reads it. `remote_upstream` carries the tunnel address instead
   * (`k8s-frontend:9053`), which is arguably what this field was meant to
   * hold: `remoteUpstream` is documented as "a cluster Service" but can never
   * be cluster DNS, since the one Caddy is a docker container that can't
   * resolve CoreDNS. Decide which it is — fold the tunnel address into `k8s:`
   * and let `remoteUpstream` mean something else, or delete `k8s:`.
   */
  k8s?: string;
  /** Public host Caddy terminates for the remote (K8s) deployment. */
  remoteHostname?: string;
  /** Static upstream `host:port` for `remoteHostname` — the k8s-forwards tunnel alias. */
  remoteUpstream?: string;
}

/** Join a service name to a base domain, tolerating a stray leading dot. */
function hostFor(service: string, domain: string): string {
  return `${service}.${domain.replace(/^\.+/, "")}`;
}

/**
 * Build the `service name -> router config` map from services.yaml. Only
 * services with a `feature_router:` block are routed. Pass a pre-loaded
 * services config and/or ingress settings to avoid re-reading the files.
 */
export function loadFeatureRouters(
  servicesConfig?: ServicesConfig,
  ingress?: IngressSettings,
): Record<string, FeatureRouter> {
  const services = servicesConfig ?? loadServices();
  const ing = ingress ?? loadIngress();
  const routers: Record<string, FeatureRouter> = {};
  for (const [svcName, svcDef] of Object.entries(services)) {
    const fr = svcDef && typeof svcDef === "object" ? svcDef.feature_router : null;
    if (!fr) {
      continue;
    }
    const remoteUpstream = fr.remote_upstream ?? undefined;
    routers[svcName] = {
      // Explicit host wins; otherwise derive from the configured base domain.
      hostname: fr.hostname ?? hostFor(svcName, ing.local_domain),
      k8s: fr.k8s ?? undefined,
      // A remote host is only meaningful with an upstream to send it to, so
      // don't invent one for services that have no cluster deployment.
      remoteHostname:
        fr.remote_hostname ?? (remoteUpstream ? hostFor(svcName, ing.remote_domain) : undefined),
      remoteUpstream,
    };
  }
  return routers;
}

/**
 * Every public hostname the ingress terminates, sorted and deduped.
 *
 * The single list behind the Caddy site blocks, the certificate SANs and the
 * `/etc/hosts` entries — see the module docstring.
 */
export function ingressHostnames(
  servicesConfig?: ServicesConfig,
  ingress?: IngressSettings,
): string[] {
  const hosts = new Set<string>();
  for (const router of Object.values(loadFeatureRouters(servicesConfig, ingress))) {
    if (router.hostname) hosts.add(router.hostname);
    if (router.remoteHostname) hosts.add(router.remoteHostname);
  }
  return [...hosts].sort();
}

/**
 * Absolute URL for a path on the feature ingress, e.g. `/orders` →
 * `https://frontend.local.werkmeister.io/orders`. Null when nothing is routed.
 *
 * Shared by `sandbox open` and the MCP server's open-feature tool so the two
 * land on the same page: the routed host set is per-machine (ingress config +
 * `feature_router:` blocks), so a hardcoded host opens a page that may not
 * exist, and a second copy of this would drift from the first.
 */
export function featureUrl(urlPath: string): string | null {
  let hosts: string[];
  try {
    hosts = ingressHostnames();
  } catch {
    return null;
  }
  if (!hosts.length) return null;
  return `https://${hosts[0]}${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`;
}
