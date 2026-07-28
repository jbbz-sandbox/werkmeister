# Minimal image for `kubectl port-forward`ing cluster services onto the Docker
# network. Replaces the ~1GB google/cloud-sdk base: OrbStack authenticates via
# the client cert embedded in the mounted kubeconfig, so no gcloud / GKE auth
# plugin is needed — just kubectl and a shell.
#
# Pinned to a content digest to prevent an unnoticed image swap (SEC-03/D-13).
# To refresh: docker pull alpine:3.21 && docker inspect --format='{{index .RepoDigests 0}}' alpine:3.21
# alpine:3.21
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

# kubectl: port-forward + resource discovery. bash: the entrypoint uses arrays,
# [[ ]], here-strings, and `wait -n`. netcat-openbsd: the `nc -z` / `nc -w` health
# probes (busybox nc lacks -z). Everything else (awk/sed/grep/date/mktemp) is busybox.
RUN apk add --no-cache kubectl bash netcat-openbsd

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
