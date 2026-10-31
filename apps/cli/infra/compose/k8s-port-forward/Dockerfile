# Minimal image for `kubectl port-forward`ing cluster services onto the Docker
# network. Deliberately tiny: OrbStack authenticates via the client cert
# embedded in the mounted kubeconfig, so no cloud-provider SDK or auth plugin
# is needed — just kubectl and a shell.
#
# Pinned to a content digest to prevent an unnoticed image swap (SEC-03/D-13).
# To refresh: docker pull alpine:3.21 && docker inspect --format='{{index .RepoDigests 0}}' alpine:3.21
# alpine:3.21
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

# kubectl: port-forward + resource discovery. bash: the entrypoint uses arrays,
# [[ ]], here-strings, and `wait -n`. netcat-openbsd: the `nc -z` / `nc -w` health
# probes (busybox nc lacks -z). redis + postgresql-client are there for
# `redis-cli` and `pg_isready` alone (~7MB): a datastore forward that went dead
# still accepts TCP, so proving it alive takes a real protocol reply, not a
# connect (probe.sh). Everything else (awk/sed/grep/date/mktemp) is busybox.
#
# corp_ca secret: on machines behind a TLS-intercepting proxy (Netskope/Zscaler),
# outbound HTTPS from the build hits a cert the host trusts but alpine's shipped
# root store doesn't. `werkmeister infra connect` extracts the proxy root into
# ~/.werkmeister/corp-ca.crt and mounts it as a BuildKit secret. Missing/empty file
# is a no-op — off-proxy builds work unchanged. The CA is appended to alpine's
# combined bundle before apk runs, so the fetch validates cleanly.
RUN --mount=type=secret,id=corp_ca,target=/tmp/corp-ca.crt \
    sh -c '[ -s /tmp/corp-ca.crt ] && cat /tmp/corp-ca.crt >> /etc/ssl/cert.pem; \
           apk add --no-cache kubectl bash netcat-openbsd redis postgresql-client'

COPY entrypoint.sh probe.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/probe.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
