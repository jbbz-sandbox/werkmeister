# `sandbox intercept` (GKE live-testing via Telepresence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sandbox intercept` command that routes a header-scoped slice of live GKE dev traffic to a feature's locally running service via Telepresence OSS, additive to (never touching) the docker-compose path.

**Architecture:** A new `apps/cli/src/commands/intercept.ts` subcommand plus one lib module `apps/cli/src/lib/telepresence.ts` that wraps the Telepresence CLI (arg-builders are pure functions; subprocess calls go through an injectable runner). All cluster coordinates come from `infra/config/services.yaml` (`gke_deployment`, `gke_namespace`, new `gke_port_name`, new top-level `gke_context`). The intercept target is the compose-run container `sandbox up` already publishes on the feature's slot host port. `sandbox down` gains a best-effort intercept cleanup; `sandbox setup` gains a version-report step.

**Tech Stack:** Node 20+ / argparse / subprocess (existing CLI stack), Telepresence OSS ≥ 2.30.0 (Apache-2.0 CNCF build), vitest via uv.

**Spec:** `docs/superpowers/specs/2026-07-19-sandbox-gke-intercept-design.md` (accepted 2026-07-19).

## Global Constraints

- Do NOT modify the docker-compose path: `up`/`init-workspace` flow, templates, Caddy routing, slot allocation, `gke-forwards` all stay behaviorally unchanged (spec §9).
- Target cluster is dev only: kube context `gke_tr-dev-361214_us-central1_tr-dev-gke` (spec §9).
- Header filter is exactly `x-feature=<feature>` — matches the sandbox's existing X-Feature convention (spec §4).
- Telepresence OSS ≥ **2.30.0**; install hint is `brew install datawire/blackbird/telepresence-oss`.
- v1 is `intercept` mode only; `wiretap`/`replace` are Phase-3 polish (spec §7) — do not build them.
- All service definitions live in `infra/config/services.yaml`; no hardcoded service names, ports, deployments, or contexts in TypeScript (repo CLAUDE.md Conventions).
- One file per subcommand in `cli/commands/`; shared logic in `cli/lib/` (repo CLAUDE.md Conventions).
- Cleanup/reporting hooks must be best-effort: teardown and setup must never block on Telepresence (matches `down.ts`'s never-block style).
- Run tests from the repo root: `npx vitest run apps/cli/src/lib/__tests__/<file> -v`.
- **Tasks 3–9 are gated on Task 1's spike outcome.** If the spike falls back to mirrord, STOP and return to the human — the lib module boundary is the swap point.

---

### Task 1: Phase-0 spike (manual, gating — no repo code)

**Files:**
- Create: `docs/gke-intercept-spike.md` (findings runbook — filled in as you go)

**Interfaces:**
- Produces: go/no-go decision; the verified `telepresence status --output json` key shape (consumed by Task 5); the connect-mode default (host vs `--docker`, consumed by Task 6); the header-propagation answer that sets v1 service scope (consumed by Task 9's docs).

This task is performed by a human (or an agent with cluster access) against the live dev cluster. Record every command + outcome in `docs/gke-intercept-spike.md`.

- [ ] **Step 1: Check whether tr-dev-gke is a private cluster** (decides the webhook firewall rule, spec §8 Q2)

```bash
gcloud container clusters describe tr-dev-gke --region us-central1 \
  --project tr-dev-361214 --format="value(privateClusterConfig.enablePrivateNodes)"
```

Expected: `True` or empty. If `True`, add the master→node firewall rule for TCP 8443 before Step 3 (see https://telepresence.io/docs/troubleshooting — "mutating webhook").

- [ ] **Step 2: Audit named ports for the two spike services** (spec §8 Q3)

```bash
kubectl --context gke_tr-dev-361214_us-central1_tr-dev-gke -n web-v2 \
  get svc -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.ports[*].targetPort}{"\n"}{end}'
kubectl --context gke_tr-dev-361214_us-central1_tr-dev-gke -n product \
  get svc -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.ports[*].targetPort}{"\n"}{end}'
```

Numeric `targetPort` values = the ambient blocker ([telepresenceio#3990](https://github.com/telepresenceio/telepresence/issues/3990)). Fix in the owning deploy manifests/Helm charts: name the `containerPort` (`name: http`) and set the Service `targetPort: http`. Record which repos/files were touched.

- [ ] **Step 3: Install a namespace-scoped traffic-manager** (spike scope: just the two namespaces)

```bash
brew install datawire/blackbird/telepresence-oss
telepresence version   # expect OSS v2.30.x
telepresence helm install --set "namespaces={web-v2,product}" \
  --kube-context gke_tr-dev-361214_us-central1_tr-dev-gke
```

- [ ] **Step 4: Test both connect modes with the corporate VPN up** (decides Task 6's default)

```bash
telepresence connect --context gke_tr-dev-361214_us-central1_tr-dev-gke --namespace web-v2
telepresence status --output json   # SAVE THIS OUTPUT into the spike doc — Task 5 codes against it
telepresence quit -s
telepresence connect --docker --context gke_tr-dev-361214_us-central1_tr-dev-gke --namespace web-v2
telepresence status --output json
telepresence quit -s
```

Record: does host mode fight the VPN? Does `--docker` mode reach a host-published port (needed because our intercept target is `localhost:<slot-port>` on the host)? Whichever works becomes the default in Task 6.

- [ ] **Step 5: Header-filtered intercept on the edge service (web-v2)**

Bring up a feature locally first (`sandbox up <feature> -s web-v2`), note its slot port (printed by `up`), then:

```bash
telepresence connect --context gke_tr-dev-361214_us-central1_tr-dev-gke --namespace web-v2
telepresence intercept <web-v2 gke_deployment name> --port <slot-port>:http \
  --http-header x-feature=jay-spike --mounts false
curl -is -H 'x-feature: jay-spike' https://sb-web.dev.sandbox.com/ | head -5
curl -is https://sb-web.dev.sandbox.com/ | head -5   # control: must NOT hit the laptop
```

Expected: the first curl reaches the local container (watch its logs); the second doesn't.

- [ ] **Step 6: Header-filtered intercept on the deep service (product-api)** — the §6.3 answer

Repeat Step 5 against product-api's deployment in namespace `product`, then drive a request through the real chain (browser → dev URL with the `x-feature` header → federated-graph → product-api). Record: **does the header survive to product-api?** (The `x-feature-propagation` workspace is implementing gateway→subgraph propagation; if it hasn't shipped to dev yet, expect NO and record that v1 scope = edge services until it ships.)

- [ ] **Step 7: Record the go/no-go**

Fill `docs/gke-intercept-spike.md` with: private-cluster answer, named-port audit results, chosen connect mode, saved `status --output json` shape, edge + deep propagation results, and the decision: proceed with Telepresence (Tasks 2–9) / fall back to mirrord (STOP, return to human).

- [ ] **Step 8: Commit the spike doc**

```bash
git add docs/gke-intercept-spike.md
git commit -m "docs(intercept): phase-0 telepresence spike findings"
```

---

### Task 2: Phase-1 platform rollout (manual — no repo code)

**Files:**
- Modify: `docs/gke-intercept-spike.md` (append rollout section)

**Interfaces:**
- Consumes: Task 1's go decision and named-port audit method.
- Produces: traffic-manager covering all sandbox namespaces; the list of services with named ports (consumed by Task 3's `gke_port_name` entries).

- [ ] **Step 1: Extend the traffic-manager to every sandbox service namespace**

The namespaces are the distinct `gke_namespace` values in `infra/config/services.yaml` (currently: `sandbox`, `web-v2`, `product`, `category`, `federated-graph`, `vendor-portal`, `taxonomy-service`, `interview-service`, `award-service`, `user-service`, `sandbox-mcp`):

```bash
telepresence helm upgrade --set "namespaces={sandbox,web-v2,product,category,federated-graph,vendor-portal,taxonomy-service,interview-service,award-service,user-service,sandbox-mcp}" \
  --kube-context gke_tr-dev-361214_us-central1_tr-dev-gke
```

- [ ] **Step 2: Run the Task-1 named-port audit across all those namespaces; fix numeric targetPorts in the deploy repos**

Append the per-service result table (service → named port yes/no → port name) to `docs/gke-intercept-spike.md`. Every service marked "yes" gets a `gke_port_name` entry in Task 3.

- [ ] **Step 3: Commit**

```bash
git add docs/gke-intercept-spike.md
git commit -m "docs(intercept): phase-1 rollout — namespaces + named-port audit table"
```

---

### Task 3: Registry keys — `gke_context` + `gke_port_name` + `get_gke_context()`

**Files:**
- Modify: `infra/config/services.yaml` (top-level key + per-service keys)
- Modify: `apps/cli/src/lib/config.ts` (new loader, next to `load_services()` at ~line 230)
- Test: `apps/cli/src/lib/__tests__/gke_context.test.ts`

**Interfaces:**
- Produces: `get_gke_context() -> str` in `cli.lib.config` (raises `RuntimeError` when the key is missing); `gke_port_name: <str>` as an optional per-service key in the services registry (read by Task 6 via the existing `load_services()`).

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/lib/__tests__/gke_context.test.ts`:

```node
"""Tests for cli.lib.config.get_gke_context (services.yaml top-level gke_context)."""

from __future__ import annotations

import vitest
from cli.lib.config import get_gke_context


def test_get_gke_context_returns_dev_cluster_context():
    # Characterization against the repo's real services.yaml.
    assert get_gke_context() == "gke_tr-dev-361214_us-central1_tr-dev-gke"


def test_get_gke_context_missing_key_raises(monkeypatch, tmp_path):
    infra = tmp_path / "infra"
    (infra / "config").mkdir(parents=True)
    (infra / "config" / "services.yaml").write_text("services: {}\n")
    monkeypatch.setattr("cli.lib.config.get_infra_root", lambda: infra)
    with vitest.raises(RuntimeError, match="gke_context"):
        get_gke_context()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/gke_context.test.ts -v`
Expected: FAIL with `ImportError: cannot import name 'get_gke_context'`

- [ ] **Step 3: Add the top-level key to services.yaml**

In `infra/config/services.yaml`, directly above the `services:` mapping, add:

```yaml
# Kube context for the dev cluster — consumed by `sandbox intercept`
# (apps/cli/src/lib/telepresence.ts). Dev only; never point this at stage/prod.
gke_context: gke_tr-dev-361214_us-central1_tr-dev-gke
```

- [ ] **Step 4: Add `gke_port_name` to the audited services**

For every service Task 2's audit marked "named port: yes", add one line beside its existing `gke_port:` key (use the actual port name from the audit; `http` shown as the common case):

```yaml
    gke_port_name: http
```

At minimum the two spike services (web-v2, product-api) get one. Services without the key are refused by `sandbox intercept` with a pointer to the audit — that is deliberate (spec §6.2).

- [ ] **Step 5: Implement the loader**

In `apps/cli/src/lib/config.ts`, directly after `load_services()`:

```node
def get_gke_context() -> str:
    """Kube context for the dev cluster (services.yaml top-level `gke_context`).

    Consumed by `sandbox intercept`. Required when interception is used, so a
    missing key fails loud rather than defaulting to whatever kubectl context
    happens to be current — intercepting the wrong cluster is the failure mode
    this guards against.
    """
    data = _load_yaml(get_infra_root() / "config" / "services.yaml", required=True)
    context = data.get("gke_context")
    if not context or not isinstance(context, str):
        raise RuntimeError(
            "services.yaml has no top-level `gke_context` key — add the dev "
            "cluster kube context there (see docs/gke-intercept.md)."
        )
    return context
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/gke_context.test.ts -v`
Expected: 2 PASS

- [ ] **Step 7: Run the full suite (registry edits must not break generation tests)**

Run: `npx vitest run apps/cli/src/lib/__tests__/ -q`
Expected: all pass (the drift guard `gke_forward_drift.test.ts` reads services.yaml — additive keys must not trip it; if it fails, the fix belongs in this task).

- [ ] **Step 8: Commit**

```bash
git add infra/config/services.yaml apps/cli/src/lib/config.ts apps/cli/src/lib/__tests__/gke_context.test.ts
git commit -m "feat(intercept): gke_context + gke_port_name registry keys, get_gke_context loader"
```

---

### Task 4: `apps/cli/src/lib/telepresence.ts` — version check and arg builders (pure functions)

**Files:**
- Create: `apps/cli/src/lib/telepresence.ts`
- Test: `apps/cli/src/lib/__tests__/telepresence.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5–8):
  - `MIN_VERSION: tuple[int, int, int]` = `(2, 30, 0)`; `INSTALL_HINT: str`
  - `parse_version(output: str) -> tuple[int, int, int] | None`
  - `version_error(runner=_run) -> str | None` (None = OK; str = human-readable problem)
  - `build_connect_args(context: str, namespace: str, docker: bool = False) -> list[str]`
  - `build_intercept_args(deployment: str, local_port: int, port_name: str, feature: str) -> list[str]`
  - `build_leave_args(deployment: str) -> list[str]`
  - `Runner = Callable[[list[str]], tuple[int, str]]`; `_run(cmd: list[str]) -> tuple[int, str]`

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/lib/__tests__/telepresence.test.ts`:

```node
"""Tests for cli.lib.telepresence — pure helpers (no subprocess in this file's targets)."""

from __future__ import annotations

from cli.lib.telepresence import (
    INSTALL_HINT,
    MIN_VERSION,
    build_connect_args,
    build_intercept_args,
    build_leave_args,
    parse_version,
    version_error,
)


def test_parse_version_extracts_semver():
    assert parse_version("OSS Client         : v2.30.1") == (2, 30, 1)


def test_parse_version_garbage_returns_none():
    assert parse_version("command not found") is None


def test_min_version_is_2_30_0():
    assert MIN_VERSION == (2, 30, 0)


def test_version_error_missing_binary(monkeypatch):
    monkeypatch.setattr("cli.lib.telepresence.shutil.which", lambda _: None)
    msg = version_error()
    assert msg is not None and INSTALL_HINT in msg


def test_version_error_too_old(monkeypatch):
    monkeypatch.setattr("cli.lib.telepresence.shutil.which", lambda _: "/usr/local/bin/telepresence")
    msg = version_error(runner=lambda cmd: (0, "OSS Client : v2.24.0"))
    assert msg is not None and "2.24.0" in msg


def test_version_error_current_version_ok(monkeypatch):
    monkeypatch.setattr("cli.lib.telepresence.shutil.which", lambda _: "/usr/local/bin/telepresence")
    assert version_error(runner=lambda cmd: (0, "OSS Client : v2.30.1")) is None


def test_build_connect_args_host_mode():
    assert build_connect_args("ctx", "product") == [
        "telepresence", "connect", "--context", "ctx", "--namespace", "product",
    ]


def test_build_connect_args_docker_mode():
    assert build_connect_args("ctx", "product", docker=True) == [
        "telepresence", "connect", "--docker", "--context", "ctx", "--namespace", "product",
    ]


def test_build_intercept_args():
    assert build_intercept_args("product-api", 11403, "http", "my-feat") == [
        "telepresence", "intercept", "product-api",
        "--port", "11403:http",
        "--http-header", "x-feature=my-feat",
        "--mounts", "false",
    ]


def test_build_leave_args():
    assert build_leave_args("product-api") == ["telepresence", "leave", "product-api"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/telepresence.test.ts -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'cli.lib.telepresence'`

- [ ] **Step 3: Implement the module**

Create `apps/cli/src/lib/telepresence.ts`:

```node
"""
Telepresence OSS wrapper for `sandbox intercept` (live testing in GKE dev).

Design (2026-07-19-sandbox-gke-intercept-design.md §5): this module is the
single seam between the sandbox CLI and the interception tool — arg builders
are pure functions, subprocess execution goes through an injectable runner,
and every cluster coordinate comes from services.yaml. Swapping the backend
(e.g. to mirrord) means replacing this module only.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

MIN_VERSION: tuple[int, int, int] = (2, 30, 0)
INSTALL_HINT = (
    "Install Telepresence OSS >= 2.30: brew install datawire/blackbird/telepresence-oss "
    "(https://telepresence.io/docs/install/client)"
)

Runner = Callable[[list[str]], tuple[int, str]]


def _run(cmd: list[str], timeout: int = 120) -> tuple[int, str]:
    """Run *cmd*, returning (returncode, combined output). Never raises."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return 127, f"{cmd[0]}: command not found"
    except subprocess.TimeoutExpired:
        return 124, f"{' '.join(cmd)}: timed out after {timeout}s"
    return proc.returncode, ((proc.stdout or "") + (proc.stderr or "")).strip()


def parse_version(output: str) -> tuple[int, int, int] | None:
    """Extract the first vX.Y.Z in *output* as an int tuple, or None."""
    match = re.search(r"v(\d+)\.(\d+)\.(\d+)", output)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def version_error(runner: Runner = _run) -> str | None:
    """Return a human-readable problem with the telepresence client, or None if OK."""
    if shutil.which("telepresence") is None:
        return f"telepresence not found on PATH. {INSTALL_HINT}"
    rc, out = runner(["telepresence", "version"])
    version = parse_version(out)
    if rc != 0 or version is None:
        first = out.splitlines()[0] if out else "no output"
        return f"could not determine telepresence version ({first}). {INSTALL_HINT}"
    if version < MIN_VERSION:
        have = ".".join(map(str, version))
        need = ".".join(map(str, MIN_VERSION))
        return f"telepresence {have} is too old (need >= {need}). {INSTALL_HINT}"
    return None


def build_connect_args(context: str, namespace: str, docker: bool = False) -> list[str]:
    args = ["telepresence", "connect"]
    if docker:
        args.append("--docker")
    args += ["--context", context, "--namespace", namespace]
    return args


def build_intercept_args(
    deployment: str, local_port: int, port_name: str, feature: str,
) -> list[str]:
    # --port <local>:<named-port>: the named port is the ambient-mesh
    # precondition (telepresenceio#3990) — hijack by port rename, no iptables.
    # --mounts false: volume mounts need FUSE-T; we only route traffic.
    return [
        "telepresence", "intercept", deployment,
        "--port", f"{local_port}:{port_name}",
        "--http-header", f"x-feature={feature}",
        "--mounts", "false",
    ]


def build_leave_args(deployment: str) -> list[str]:
    return ["telepresence", "leave", deployment]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/telepresence.test.ts -v`
Expected: 10 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/telepresence.ts apps/cli/src/lib/__tests__/telepresence.test.ts
git commit -m "feat(intercept): telepresence lib — version check + pure arg builders"
```

---

### Task 5: `apps/cli/src/lib/telepresence.ts` — connection management and cleanup

**Files:**
- Modify: `apps/cli/src/lib/telepresence.ts` (append)
- Test: `apps/cli/src/lib/__tests__/telepresence.test.ts` (append)

**Interfaces:**
- Consumes: Task 4's `Runner`, `_run`, `build_connect_args`, `build_leave_args`.
- Produces (consumed by Tasks 6–7):
  - `connected_namespace(runner=_run) -> str | None`
  - `ensure_connected(context: str, namespace: str, docker: bool = False, runner=_run) -> None` (raises `RuntimeError` on connect failure)
  - `leave_feature_intercepts(feature: str, runner=_run) -> list[str]` (returns deployments left; never raises on tool absence)

> **Spike dependency:** the exact `telepresence status --output json` key shape was recorded in Task 1 Step 4. The code below treats *any* parse miss as "not connected" (safe: connect is then attempted), but adjust the key lookups to match the saved output before committing.

- [ ] **Step 1: Write the failing tests** (append to `telepresence.test.ts`)

```node
import json

from cli.lib.telepresence import (
    connected_namespace,
    ensure_connected,
    leave_feature_intercepts,
)


class RecordingRunner:
    """Scripted runner: returns queued (rc, out) pairs and records commands."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.commands: list[list[str]] = []

    def __call__(self, cmd):
        self.commands.append(cmd)
        return self.responses.pop(0) if self.responses else (0, "")


def _status_json(namespace):
    return json.dumps({"user_daemon": {"status": "Connected", "namespace": namespace}})


def test_connected_namespace_parses_status():
    runner = RecordingRunner([(0, _status_json("product"))])
    assert connected_namespace(runner=runner) == "product"


def test_connected_namespace_bad_json_is_none():
    runner = RecordingRunner([(0, "not json")])
    assert connected_namespace(runner=runner) is None


def test_ensure_connected_short_circuits_when_namespace_matches():
    runner = RecordingRunner([(0, _status_json("product"))])
    ensure_connected("ctx", "product", runner=runner)
    assert len(runner.commands) == 1  # status only — no quit, no connect


def test_ensure_connected_reconnects_on_namespace_mismatch():
    runner = RecordingRunner([
        (0, _status_json("web-v2")),  # status: connected elsewhere
        (0, ""),                       # quit -s
        (0, "connected"),              # connect
    ])
    ensure_connected("ctx", "product", runner=runner)
    assert runner.commands[1] == ["telepresence", "quit", "-s"]
    assert runner.commands[2] == [
        "telepresence", "connect", "--context", "ctx", "--namespace", "product",
    ]


def test_ensure_connected_raises_on_connect_failure():
    runner = RecordingRunner([(1, ""), (0, ""), (1, "boom")])
    import vitest
    with vitest.raises(RuntimeError, match="boom"):
        ensure_connected("ctx", "product", runner=runner)


def test_leave_feature_intercepts_no_binary_is_noop(monkeypatch):
    monkeypatch.setattr("cli.lib.telepresence.shutil.which", lambda _: None)
    assert leave_feature_intercepts("my-feat") == []


def test_leave_feature_intercepts_leaves_each_local_service(monkeypatch, tmp_path):
    monkeypatch.setattr("cli.lib.telepresence.shutil.which", lambda _: "/bin/telepresence")
    (tmp_path / ".env").write_text("FEATURE=my-feat\nSERVICES=product-api,web-v2\n")
    monkeypatch.setattr(
        "cli.lib.docker.workspace_for_feature", lambda feature: tmp_path,
    )
    monkeypatch.setattr(
        "cli.lib.config.load_services",
        lambda: {
            "product-api": {"gke_deployment": "product-api-deploy"},
            "web-v2": {"gke_deployment": "web-v2-deploy"},
        },
    )
    runner = RecordingRunner([(0, ""), (1, "no such intercept")])
    left = leave_feature_intercepts("my-feat", runner=runner)
    assert left == ["product-api-deploy"]  # second leave failed rc=1 → excluded
    assert runner.commands == [
        ["telepresence", "leave", "product-api-deploy"],
        ["telepresence", "leave", "web-v2-deploy"],
    ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/telepresence.test.ts -v`
Expected: new tests FAIL with `ImportError: cannot import name 'connected_namespace'`

- [ ] **Step 3: Implement** (append to `apps/cli/src/lib/telepresence.ts`)

```node
def connected_namespace(runner: Runner = _run) -> str | None:
    """The namespace the user daemon is connected to, or None if disconnected.

    Any parse miss is treated as disconnected — the caller then (re)connects,
    which is idempotent-safe. Key shape verified against the Task-1 spike's
    saved `telepresence status --output json` output.
    """
    rc, out = runner(["telepresence", "status", "--output", "json"])
    if rc != 0:
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    daemon = data.get("user_daemon") or {}
    if daemon.get("status") == "Connected" or daemon.get("running"):
        return daemon.get("namespace") or None
    return None


def ensure_connected(
    context: str, namespace: str, docker: bool = False, runner: Runner = _run,
) -> None:
    """Connect the telepresence daemon to *namespace*, reusing a live session.

    A session bound to a different namespace is quit first — telepresence
    binds one namespace per connect, and a stale binding intercepts nothing.
    """
    current = connected_namespace(runner=runner)
    if current == namespace:
        return
    if current is not None:
        runner(["telepresence", "quit", "-s"])
    rc, out = runner(build_connect_args(context, namespace, docker=docker))
    if rc != 0:
        raise RuntimeError(f"telepresence connect failed: {out or 'no output'}")


def _services_from_env(env_path: Path) -> list[str]:
    """SERVICES list from a workspace .env (same format up.ts reads)."""
    if not env_path.is_file():
        return []
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line.startswith("SERVICES="):
            value = line.split("=", 1)[1]
            return [s.strip() for s in value.split(",") if s.strip()]
    return []


def leave_feature_intercepts(feature: str, runner: Runner = _run) -> list[str]:
    """Best-effort: leave the intercepts of *feature*'s local services.

    Called from `sandbox down` — must never block teardown, so a missing
    binary, missing workspace, or failed leave is silently skipped. Returns
    the deployments actually left. Imports are local to keep `down` fast
    when telepresence was never used.
    """
    if shutil.which("telepresence") is None:
        return []
    from cli.lib.config import load_services
    from cli.lib.docker import workspace_for_feature

    workspace = workspace_for_feature(feature)
    if workspace is None:
        return []
    services = _services_from_env(workspace / ".env")
    if not services:
        return []
    registry = load_services()
    left: list[str] = []
    for svc in services:
        svc_def = registry.get(svc)
        deployment = svc_def.get("gke_deployment") if isinstance(svc_def, dict) else None
        if not deployment:
            continue
        rc, _out = runner(build_leave_args(deployment))
        if rc == 0:
            left.append(deployment)
    return left
```

> Note for the monkeypatch targets in Step 1's last test: because the imports
> are function-local, patch the *source* modules (`cli.lib.docker.workspace_for_feature`,
> `cli.lib.config.load_services`) exactly as the test does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/telepresence.test.ts -v`
Expected: all PASS (17 total)

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/telepresence.ts apps/cli/src/lib/__tests__/telepresence.test.ts
git commit -m "feat(intercept): telepresence connection management + feature intercept cleanup"
```

---

### Task 6: `sandbox intercept` command + parser wiring

**Files:**
- Create: `apps/cli/src/commands/intercept.ts`
- Modify: `apps/cli/src/main.ts` (parser block after the `up`/`down` parsers; `_COMMAND_MODULES` at line ~731)
- Test: `apps/cli/src/lib/__tests__/intercept_command.test.ts`

**Interfaces:**
- Consumes: `get_gke_context()` (Task 3); `version_error`, `ensure_connected`, `build_intercept_args`, `build_leave_args`, `leave_feature_intercepts`, `_run` (Tasks 4–5); existing `resolve_workspace(feature, override)`, `load_services()`, `get_slot(feature)`, `get_service_port(slot, port_offset)`.
- Produces: `run(args)` entry point; args namespace fields: `feature`, `service`, `leave`, `status`, `docker_daemon`, `workspace`.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/src/lib/__tests__/intercept_command.test.ts`:

```node
"""Tests for cli.commands.intercept — validation and happy-path orchestration."""

from __future__ import annotations

import argparse

import vitest
from cli.commands import intercept


def _args(**overrides):
    base = dict(
        feature="my-feat", service="product-api", leave=False, status=False,
        docker_daemon=False, workspace=None,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


@vitest.fixture
def workspace(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "FEATURE=my-feat\nSERVICES=product-api,web-v2\nSANDBOX_SLOT=4\n"
    )
    monkeypatch.setattr(intercept, "resolve_workspace", lambda f, o=None: tmp_path)
    return tmp_path


@vitest.fixture
def registry(monkeypatch):
    services = {
        "product-api": {
            "port_offset": 3,
            "gke_deployment": "product-api-deploy",
            "gke_namespace": "product",
            "gke_port_name": "http",
        },
        "web-v2": {"port_offset": 2, "gke_deployment": "web-v2-deploy",
                   "gke_namespace": "web-v2"},  # no gke_port_name
    }
    monkeypatch.setattr(intercept, "load_services", lambda: services)
    monkeypatch.setattr(intercept, "get_gke_context", lambda: "ctx")
    monkeypatch.setattr(intercept.tp, "version_error", lambda: None)
    return services


def test_missing_service_flag_exits(workspace, registry):
    with vitest.raises(SystemExit):
        intercept.run(_args(service=None))


def test_service_not_local_exits(workspace, registry):
    with vitest.raises(SystemExit):
        intercept.run(_args(service="category-api"))


def test_missing_gke_port_name_exits_with_audit_pointer(workspace, registry, capsys):
    with vitest.raises(SystemExit):
        intercept.run(_args(service="web-v2"))
    assert "gke_port_name" in capsys.readouterr().out


def test_local_port_not_listening_exits(workspace, registry, monkeypatch):
    monkeypatch.setattr(intercept, "get_slot", lambda f: 4)
    monkeypatch.setattr(intercept, "_port_open", lambda p: False)
    with vitest.raises(SystemExit):
        intercept.run(_args())


def test_happy_path_connects_then_intercepts(workspace, registry, monkeypatch):
    monkeypatch.setattr(intercept, "get_slot", lambda f: 4)
    monkeypatch.setattr(intercept, "get_service_port", lambda slot, off: 11403)
    monkeypatch.setattr(intercept, "_port_open", lambda p: True)
    calls = []
    monkeypatch.setattr(
        intercept.tp, "ensure_connected",
        lambda context, namespace, docker=False: calls.append(("connect", context, namespace, docker)),
    )
    monkeypatch.setattr(
        intercept.tp, "_run", lambda cmd: (calls.append(("run", cmd)) or (0, "intercepted")),
    )
    intercept.run(_args())
    assert calls[0] == ("connect", "ctx", "product", False)
    assert calls[1] == ("run", [
        "telepresence", "intercept", "product-api-deploy",
        "--port", "11403:http", "--http-header", "x-feature=my-feat",
        "--mounts", "false",
    ])


def test_leave_single_service(workspace, registry, monkeypatch):
    calls = []
    monkeypatch.setattr(intercept.tp, "_run", lambda cmd: (calls.append(cmd) or (0, "")))
    intercept.run(_args(leave=True))
    assert calls == [["telepresence", "leave", "product-api-deploy"]]


def test_leave_all_without_service(workspace, registry, monkeypatch):
    called = []
    monkeypatch.setattr(
        intercept.tp, "leave_feature_intercepts", lambda feature: (called.append(feature) or []),
    )
    intercept.run(_args(leave=True, service=None))
    assert called == ["my-feat"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/intercept_command.test.ts -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'cli.commands.intercept'`

- [ ] **Step 3: Implement the command**

Create `apps/cli/src/commands/intercept.ts`:

```node
"""
sandbox intercept <feature> -s <service>

Route a header-scoped slice of live GKE **dev** traffic to the feature's
local service via Telepresence OSS (2026-07-19-sandbox-gke-intercept-design.md).
Additive to the compose path: the container `sandbox up` publishes on the
slot host port is the intercept target, so hot-reload keeps working. Only
requests carrying `x-feature: <feature>` are rerouted; teammates and
baseline dev traffic are untouched.
"""

from __future__ import annotations

import socket
import sys
from pathlib import Path

from cli.lib import telepresence as tp
from cli.lib.config import (
    Colors,
    error,
    get_gke_context,
    info,
    load_services,
    resolve_workspace,
    success,
)
from cli.lib.slots import get_service_port, get_slot

DEV_URL = "https://sb-web.dev.sandbox.com"


def _load_dotenv(start: Path) -> dict[str, str]:
    """Walk up from *start* looking for a .env file; return its key=value pairs."""
    for directory in [start, *start.parents]:
        env_file = directory / ".env"
        if env_file.is_file():
            result = {}
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                result[key.strip()] = value.strip()
            return result
    return {}


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("localhost", port), timeout=1):
            return True
    except OSError:
        return False


def _fail(message: str) -> None:
    error(message)
    sys.exit(1)


def _resolve_service_def(service: str, workspace: Path) -> dict:
    """Validate *service* is a local service of this workspace with full GKE
    coordinates; return its services.yaml definition."""
    workspace_env = _load_dotenv(workspace)
    local = [s.strip() for s in workspace_env.get("SERVICES", "").split(",") if s.strip()]
    if service not in local:
        _fail(
            f"'{service}' is not a local service of this workspace "
            f"(SERVICES={','.join(local) or '(none)'}). Add it to "
            "workspace.yml services and rerun `sandbox init-workspace`."
        )
    svc_def = load_services().get(service)
    if not isinstance(svc_def, dict):
        _fail(f"'{service}' not found in infra/config/services.yaml.")
    missing = [k for k in ("gke_deployment", "gke_namespace") if not svc_def.get(k)]
    if missing:
        _fail(f"'{service}' has no {'/'.join(missing)} in services.yaml — not interceptable.")
    if not svc_def.get("gke_port_name"):
        _fail(
            f"'{service}' has no gke_port_name in services.yaml. Interception "
            "under Istio ambient requires a NAMED Service targetPort "
            "(docs/gke-intercept.md — named-port audit); add the port name "
            "there once the service's manifests are fixed."
        )
    return svc_def


def run(args) -> None:
    """Execute ``sandbox intercept``."""
    if getattr(args, "status", False):
        for cmd in (["telepresence", "status"], ["telepresence", "list"]):
            _rc, out = tp._run(cmd)
            print(out)
        return

    dotenv = _load_dotenv(Path.cwd())
    feature = args.feature or dotenv.get("FEATURE")
    if not feature:
        _fail("Feature name required: pass it as an argument or set FEATURE in a .env file.")

    workspace = resolve_workspace(feature, getattr(args, "workspace", None))
    service = getattr(args, "service", None)

    if getattr(args, "leave", False):
        if service:
            svc_def = _resolve_service_def(service, workspace)
            rc, out = tp._run(tp.build_leave_args(svc_def["gke_deployment"]))
            if rc == 0:
                success(f"Left intercept for {service}.")
            else:
                _fail(f"Could not leave intercept: {out or 'no output'}")
        else:
            left = tp.leave_feature_intercepts(feature)
            if left:
                success(f"Left intercept(s): {', '.join(left)}")
            else:
                info("No active intercepts for this feature.")
        return

    if not service:
        _fail("Service required: sandbox intercept <feature> -s <service>")

    problem = tp.version_error()
    if problem:
        _fail(problem)

    svc_def = _resolve_service_def(service, workspace)

    slot = get_slot(feature)
    if slot is None:
        _fail(f"Feature '{feature}' has no allocated slot — run `sandbox up {feature}` first.")
    local_port = get_service_port(slot, svc_def.get("port_offset", 0))
    if not _port_open(local_port):
        _fail(
            f"{service} is not listening on localhost:{local_port} — "
            f"run `sandbox up {feature}` first (the local container is the intercept target)."
        )

    context = get_gke_context()
    namespace = svc_def["gke_namespace"]
    deployment = svc_def["gke_deployment"]

    info(f"Connecting to {namespace} on {context}...")
    tp.ensure_connected(context, namespace, docker=getattr(args, "docker_daemon", False))

    info(f"Intercepting {deployment} → localhost:{local_port} (x-feature={feature})...")
    rc, out = tp._run(
        tp.build_intercept_args(deployment, local_port, svc_def["gke_port_name"], feature)
    )
    if rc != 0:
        _fail(f"telepresence intercept failed: {out or 'no output'}")

    print(f"\n{Colors.GREEN}{Colors.BOLD}=== Intercept active: {service} ==={Colors.RESET}\n")
    print(f"  {Colors.CYAN}Cluster:{Colors.RESET} {context}")
    print(f"  {Colors.CYAN}Target:{Colors.RESET}  {namespace}/{deployment} → localhost:{local_port}")
    print(f"  {Colors.CYAN}Filter:{Colors.RESET}  x-feature: {feature}\n")
    print("  Only requests carrying that header are rerouted to your laptop.")
    print(f"  Try:  curl -H 'x-feature: {feature}' {DEV_URL}/<path>")
    print(f"  End:  sandbox intercept {feature} --leave -s {service}")
    print()


# ponytail: no long-running supervision — the intercept lives in the
# telepresence daemon until `--leave`/`sandbox down`; add a `--watch` mode
# only if dangling intercepts become a real problem.
```

- [ ] **Step 4: Wire into `main.ts`**

In `apps/cli/src/main.ts`, add to `_COMMAND_MODULES` (after `"down"`):

```node
    "intercept": "cli.commands.intercept",
```

And in `_build_parser()`, after the `down` parser block:

```node
    p_intercept = subparsers.add_parser(
        "intercept",
        help="Route header-scoped GKE dev traffic to a local service (Telepresence OSS).",
    )
    p_intercept.add_argument(
        "feature", nargs="?", default=None,
        help="Feature name (defaults to FEATURE from a .env file in CWD).",
    )
    p_intercept.add_argument(
        "--service", "-s", default=None,
        help="Local service to intercept (must be in the workspace's SERVICES and running via `sandbox up`).",
    )
    p_intercept.add_argument(
        "--leave", action="store_true", default=False,
        help="End the intercept for -s (or all of this feature's intercepts without -s).",
    )
    p_intercept.add_argument(
        "--status", action="store_true", default=False,
        help="Show telepresence connection and intercept status.",
    )
    p_intercept.add_argument(
        "--docker-daemon", dest="docker_daemon", action="store_true", default=False,
        help="Run the telepresence daemon in a container (connect --docker) — "
        "avoids the host TUN device and VPN routing conflicts.",
    )
    p_intercept.add_argument(
        "--workspace", default=None,
        help="Explicit workspace path (default: resolve from the feature name).",
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/intercept_command.test.ts -v`
Expected: 7 PASS

- [ ] **Step 6: Smoke the parser end-to-end**

Run: `node apps/cli/dist/main.js intercept --help` (from `apps/cli/`, or however the suite's conftest arranges imports; alternatively `./sandbox intercept --help` from repo root)
Expected: the help text above, exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/commands/intercept.ts apps/cli/src/main.ts apps/cli/src/lib/__tests__/intercept_command.test.ts
git commit -m "feat(intercept): sandbox intercept command — header-scoped GKE dev interception"
```

---

### Task 7: `sandbox down` cleanup hook

**Files:**
- Modify: `apps/cli/src/commands/down.ts` (`_down_one`, lines ~118-140)
- Test: `apps/cli/src/lib/__tests__/intercept_command.test.ts` (append)

**Interfaces:**
- Consumes: `leave_feature_intercepts(feature) -> list[str]` (Task 5).
- Produces: nothing new — teardown behavior only.

- [ ] **Step 1: Write the failing test** (append to `intercept_command.test.ts`)

```node
def test_down_leaves_intercepts_before_compose_down(monkeypatch):
    from cli.commands import down

    order = []
    monkeypatch.setattr(down, "_print_notes", lambda feature: order.append("notes"))
    monkeypatch.setattr(down, "get_slot", lambda feature: 4)
    monkeypatch.setattr(down, "compose_down", lambda feature, remove_volumes: order.append("compose_down"))
    monkeypatch.setattr(down, "release_slot", lambda feature: order.append("release"))
    monkeypatch.setattr(
        "cli.lib.telepresence.leave_feature_intercepts",
        lambda feature: (order.append("leave") or ["product-api-deploy"]),
    )
    down._down_one("my-feat", remove_volumes=False)
    assert order.index("leave") < order.index("compose_down")


def test_down_survives_telepresence_errors(monkeypatch):
    from cli.commands import down

    monkeypatch.setattr(down, "_print_notes", lambda feature: None)
    monkeypatch.setattr(down, "get_slot", lambda feature: 4)
    monkeypatch.setattr(down, "compose_down", lambda feature, remove_volumes: None)
    monkeypatch.setattr(down, "release_slot", lambda feature: None)
    monkeypatch.setattr(
        "cli.lib.telepresence.leave_feature_intercepts",
        lambda feature: (_ for _ in ()).throw(RuntimeError("daemon exploded")),
    )
    assert down._down_one("my-feat", remove_volumes=False) == 4  # no raise
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/intercept_command.test.ts -v -k down`
Expected: FAIL — "leave" never appears in `order` / first test's index() raises `ValueError`

- [ ] **Step 3: Implement the hook**

In `apps/cli/src/commands/down.ts`, inside `_down_one`, between `_print_notes(feature)` and the `slot = get_slot(feature)` line, insert:

```node
    # GKE intercept cleanup (gke-intercept spec §5): best-effort, never blocks
    # teardown. Must run before compose_down — leave_feature_intercepts resolves
    # the workspace from compose labels on the still-running containers.
    try:
        from cli.lib.telepresence import leave_feature_intercepts

        left = leave_feature_intercepts(feature)
        if left:
            info(f"Left GKE intercept(s): {', '.join(left)}")
    except Exception as exc:  # noqa: BLE001 — teardown must never block on telepresence
        warn(f"Could not clean up GKE intercepts: {exc}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/intercept_command.test.ts -v`
Expected: all PASS (9 total)

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/down.ts apps/cli/src/lib/__tests__/intercept_command.test.ts
git commit -m "feat(intercept): sandbox down leaves feature intercepts before teardown"
```

---

### Task 8: `sandbox setup` version-report step

**Files:**
- Modify: `apps/cli/src/lib/machine_setup.ts` (new `sync_telepresence`, wired into `run_setup` at line ~355)
- Test: `apps/cli/src/lib/__tests__/machine_setup.test.ts` (append)

**Interfaces:**
- Consumes: `parse_version`, `MIN_VERSION`, `INSTALL_HINT` (Task 4); machine_setup's existing `Step(label, ok, detail)` dataclass and `Runner` alias.
- Produces: `sync_telepresence(runner: Runner, check_only: bool) -> list[Step]`.

Design rule: telepresence is **optional** (only `sandbox intercept` needs it), so *missing* reports `ok=True` with an informational detail — a dev who never intercepts must not see `sandbox setup` fail. *Installed-but-too-old* reports `ok=False` (a broken install is worth converging).

- [ ] **Step 1: Write the failing tests** (append to `machine_setup.test.ts`)

```node
from cli.lib.machine_setup import sync_telepresence


def test_sync_telepresence_missing_is_ok_but_informative():
    steps = sync_telepresence(lambda cmd: (127, "telepresence: command not found"), check_only=True)
    assert len(steps) == 1
    assert steps[0].ok is True
    assert "sandbox intercept" in steps[0].detail


def test_sync_telepresence_current_version_ok():
    steps = sync_telepresence(lambda cmd: (0, "OSS Client : v2.30.1"), check_only=True)
    assert steps[0].ok is True
    assert "2.30.1" in steps[0].detail


def test_sync_telepresence_too_old_fails():
    steps = sync_telepresence(lambda cmd: (0, "OSS Client : v2.24.0"), check_only=True)
    assert steps[0].ok is False
    assert "2.24.0" in steps[0].detail
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/cli/src/lib/__tests__/machine_setup.test.ts -v -k telepresence`
Expected: FAIL with `ImportError: cannot import name 'sync_telepresence'`

- [ ] **Step 3: Implement** (add to `machine_setup.ts`, after `sync_jira_token`)

```node
def sync_telepresence(runner: Runner, check_only: bool) -> list[Step]:
    """Report the Telepresence OSS client state (never installs it).

    Optional prerequisite — only `sandbox intercept` needs it — so absence is
    ok=True with a hint, while an installed-but-stale client is ok=False.
    ``check_only`` is accepted for signature parity with the other sync steps;
    this step is always report-only.
    """
    del check_only
    from cli.lib.telepresence import INSTALL_HINT, MIN_VERSION, parse_version

    rc, out = runner(["telepresence", "version"])
    if rc != 0:
        return [Step("telepresence", True, f"not installed (optional — needed for `sandbox intercept`; {INSTALL_HINT})")]
    version = parse_version(out)
    if version is None:
        return [Step("telepresence", False, f"version unparseable: {out[:80]}")]
    have = ".".join(map(str, version))
    if version < MIN_VERSION:
        need = ".".join(map(str, MIN_VERSION))
        return [Step("telepresence", False, f"{have} < required {need} — {INSTALL_HINT}")]
    return [Step("telepresence", True, f"OSS client {have}")]
```

Then in `run_setup`, after `steps.extend(sync_jira_token(...))` (line ~355), add:

```node
    steps.extend(sync_telepresence(runner, check_only))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/cli/src/lib/__tests__/machine_setup.test.ts -v`
Expected: all PASS (existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lib/machine_setup.ts apps/cli/src/lib/__tests__/machine_setup.test.ts
git commit -m "feat(intercept): sandbox setup reports telepresence client state"
```

---

### Task 9: Docs — runbook + CLAUDE.md routing

**Files:**
- Create: `docs/gke-intercept.md`
- Modify: `CLAUDE.md` (Commands table + Routing table)

**Interfaces:**
- Consumes: Task 1's spike findings (connect-mode default, propagation scope) and Task 2's named-port audit table.

- [ ] **Step 1: Write the runbook**

Create `docs/gke-intercept.md` with exactly these sections (fill the two ALL-CAPS slots from the spike doc):

```markdown
# GKE dev interception (`sandbox intercept`)

Routes a header-scoped slice of live dev-cluster traffic
(`gke_tr-dev-361214_us-central1_tr-dev-gke`) to a feature's local service via
Telepresence OSS. Additive to the compose path — `sandbox up` still runs the
service locally; interception points real cluster traffic at that container.

## Prerequisites
- Telepresence OSS >= 2.30: `brew install datawire/blackbird/telepresence-oss`
  (`sandbox setup` reports the installed version).
- The service must have `gke_deployment`, `gke_namespace`, and `gke_port_name`
  in `infra/config/services.yaml`. `gke_port_name` exists only for services
  whose k8s Service uses a NAMED targetPort — the Istio-ambient precondition
  (telepresenceio/telepresence#3990). Audit table: docs/gke-intercept-spike.md.
- The feature must be up: `sandbox up <feature> -s <service>`.

## Usage
    sandbox intercept <feature> -s <service>     # start (filter: x-feature=<feature>)
    sandbox intercept <feature> --leave -s <svc> # end one
    sandbox intercept <feature> --leave          # end all for the feature
    sandbox intercept --status                   # daemon + intercept status
    # `sandbox down <feature>` also leaves the feature's intercepts.

Exercise it by sending requests to https://sb-web.dev.sandbox.com with the
`x-feature: <feature>` header (or cookie). Requests without the header keep
hitting the normal dev deployment — teammates are unaffected.

## Scope
CONNECT MODE DEFAULT AND WHY (from spike step 4).
SERVICES IN SCOPE FOR V1 (from spike step 6 — edge-only until x-feature
propagation through federated-graph ships to dev; see the
x-feature-propagation workspace).

## Troubleshooting
- "connection reset"/503 through the intercept → the Service's targetPort is
  numeric; fix the manifest and add `gke_port_name` (ambient iptables conflict).
- Connect fails with VPN up → retry with `--docker-daemon` (daemon runs in a
  container; no host TUN device).
- Intercept matches nothing on a deep service → the header isn't propagated
  that far yet; see Scope above.
- Root daemon password prompt on macOS → one-time launchd service install
  (telepresence 2.27+), or use `--docker-daemon`.
```

- [ ] **Step 2: Add the CLAUDE.md rows**

In `CLAUDE.md` §Commands, after the `./sandbox down` row, add:

```markdown
| Intercept GKE dev traffic to a local service | `./sandbox intercept <feature> -s <svc>` (see docs/gke-intercept.md) |
```

In `CLAUDE.md` §Routing, add:

```markdown
| Test a service against live GKE dev traffic | /apps/cli/src/commands/intercept.ts | docs/gke-intercept.md | — |
```

- [ ] **Step 3: Full suite + commit**

Run: `npx vitest run apps/cli/src/lib/__tests__/ -q`
Expected: all pass

```bash
git add docs/gke-intercept.md CLAUDE.md
git commit -m "docs(intercept): gke-intercept runbook + CLAUDE.md routing"
```

---

## Self-review (done at plan time)

- **Spec coverage:** §5 command flow → Task 6; §5 lib module → Tasks 4–5; §5 down/setup hooks → Tasks 7–8; §6.1 traffic-manager → Tasks 1/2; §6.2 named-port audit + `gke_port_name` → Tasks 2/3; §6.3 header propagation → Task 1 Step 6 + Task 9 Scope; §7 phases → task ordering; §8 open questions → Task 1 Steps 1–4. Deferred by spec: wiretap/`sandbox open --dev`/status column (Phase 3, out of plan).
- **Deviation from spec §5:** spec suggested `--docker` connect as the default; the plan makes host-mode the code default with `--docker-daemon` opt-in, because the daemon-in-container must be proven able to reach the host-published slot port first — Task 1 Step 4 decides, and flipping the default is a one-line change in Task 6.
- **Type consistency:** `version_error/parse_version/MIN_VERSION/INSTALL_HINT/build_*_args/ensure_connected/leave_feature_intercepts` names and signatures match across Tasks 4–8; `Step(label, ok, detail)` matches `machine_setup.ts:56`; `get_service_port(slot, port_offset)` matches `slots.ts:304`; `resolve_workspace(feature, override)` matches `config.ts:123`.
