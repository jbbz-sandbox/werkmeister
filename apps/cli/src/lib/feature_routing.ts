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
 * `~/.sandbox/config.yaml` rather than being restated per service:
 *
 *   ingress:                        # ~/.sandbox/config.yaml
 *     local_domain: local.sandbox.com
 *     remote_domain: remote.sandbox.com
 *
 *   next-hello:                     # ~/.sandbox/services.yaml
 *     feature_router:
 *       remote_upstream: next-hello.default.svc.cluster.local:8080
 *
 * yields `next-hello.local.sandbox.com` (local docker feature) and
 * `next-hello.remote.sandbox.com` (the cluster deployment). A service that
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

import { loadServices } from "./config.js";
import { loadIngress, type IngressSettings } from "./global_config.js";

export interface FeatureRouter {
  /** Public host Caddy terminates for the local docker feature. */
  hostname?: string;
  /** k8s baseline (`k8s-forwards:<port>`); absent for local-only services. */
  k8s?: string;
  /** Public host Caddy terminates for the remote (K8s) deployment. */
  remoteHostname?: string;
  /** Static upstream `host:port` for `remoteHostname` (e.g. a cluster Service). */
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
  servicesConfig?: Record<string, any>,
  ingress?: IngressSettings,
): Record<string, FeatureRouter> {
  const services = servicesConfig ?? loadServices();
  const ing = ingress ?? loadIngress();
  const routers: Record<string, FeatureRouter> = {};
  for (const [svcName, svcDef] of Object.entries(services)) {
    const fr = svcDef && typeof svcDef === "object" ? (svcDef as any).feature_router : null;
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
  servicesConfig?: Record<string, any>,
  ingress?: IngressSettings,
): string[] {
  const hosts = new Set<string>();
  for (const router of Object.values(loadFeatureRouters(servicesConfig, ingress))) {
    if (router.hostname) hosts.add(router.hostname);
    if (router.remoteHostname) hosts.add(router.remoteHostname);
  }
  return [...hosts].sort();
}
