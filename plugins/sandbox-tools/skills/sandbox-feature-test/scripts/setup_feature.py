#!/usr/bin/env python3
"""
setup_feature.py — Scaffold and validate a sandbox feature test environment.

Usage:
    python3 setup_feature.py --feature <name> [--workspace <path>]

Steps:
  1. Validates feature name is not already allocated (Docker slot labels)
  2. Resolves the workspace directory (same logic as sandbox's resolve_workspace)
  3. Scaffolds playwright.config.ts in workspace (if missing)
  4. Scaffolds <feature>.spec.ts in workspace (if missing)
  5. Installs the pinned @playwright/test in workspace (if missing)

Exits non-zero on name collision. Prints workspace path to stdout on success
so the caller can capture it for subsequent commands.
"""

# Keeps the `str | None` annotations working on Python < 3.10.
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"

SANDBOX_DIR = Path.home() / ".sandbox"
CONFIG_YAML = SANDBOX_DIR / "config.yaml"
SERVICES_YAML = SANDBOX_DIR / "services.yaml"

# The docker label the sandbox stamps on feature containers. Must match
# generate.ts (`com.sandbox.local.feature`) — a mismatch silently reports every
# feature name as free, because the filter matches nothing.
FEATURE_LABEL = "com.sandbox.local.feature"

# `sandbox setup` downloads Chromium for exactly this Playwright release; any
# other version looks for a browser build that isn't there. Must match
# PLAYWRIGHT_VERSION in sandbox-core/test_run.ts (a parity test enforces it).
PLAYWRIGHT_VERSION = "1.63.0"


def _scalar(path: Path, key: str) -> str | None:
    """Read a top-level-ish `key: value` scalar out of a small config YAML.

    Deliberately not PyYAML: this script runs under whatever python3 the user's
    Claude session has, and a hard third-party import would turn a missing
    dependency into a scaffolding failure. The sandbox configs are generated,
    so the flat `key: value` shape is stable.
    """
    try:
        for line in path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith(f"{key}:"):
                value = stripped.split(":", 1)[1].strip().strip("'\"")
                if value:
                    return value
    except OSError:
        return None
    return None


def resolve_ingress(base_url_override: str | None) -> tuple[str, str]:
    """Return (base_url, cookie_domain) for the configured local ingress.

    Hostnames are NOT hardcoded here: they derive from `ingress.local_domain`
    in ~/.sandbox/config.yaml joined to a routed service name from
    services.yaml, which is the same derivation feature_routing.ts uses. An
    explicit --base-url always wins.
    """
    if base_url_override:
        host = base_url_override.split("://", 1)[-1].split("/", 1)[0]
        return base_url_override.rstrip("/"), "." + host.split(".", 1)[-1]

    domain = _scalar(CONFIG_YAML, "local_domain")
    if not domain:
        print(
            f"[error] No ingress.local_domain in {CONFIG_YAML}.\n"
            f"[error] Run `sandbox setup`, or pass --base-url explicitly.",
            file=sys.stderr,
        )
        sys.exit(1)

    service = _first_routed_service()
    if not service:
        print(
            f"[error] No service declares a feature_router: block in {SERVICES_YAML}.\n"
            f"[error] Add one, or pass --base-url explicitly.",
            file=sys.stderr,
        )
        sys.exit(1)

    return f"https://{service}.{domain}", f".{domain}"


def _first_routed_service() -> str | None:
    """Name of the first service with a `feature_router:` block, or None.

    Line-oriented for the same reason as _scalar: services.yaml nests a
    `feature_router:` mapping under each service, and we only need to know
    which service key most recently preceded one.
    """
    try:
        lines = SERVICES_YAML.read_text().splitlines()
    except OSError:
        return None
    current: str | None = None
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        # Service keys sit one level under `services:` — take the shallowest
        # non-root mapping key we see, then watch for its feature_router child.
        if indent == 2 and stripped.endswith(":"):
            current = stripped[:-1]
        elif stripped.startswith("feature_router:") and current:
            return current
    return None


def resolve_workspace(workspace_override: str | None) -> Path:
    """Mirror sandbox-core's resolveWorkspace (config.ts): workspaces_root → .git-boundary walk → ~/workspace."""
    if workspace_override:
        return Path(workspace_override).resolve()
    env = os.environ.get("WORKSPACE")
    if env:
        return Path(env).resolve()
    cwd = Path.cwd()
    # A workspace root is itself a git repo, so the .git walk below would return the
    # workspaces root; under paths.workspaces_root the workspace is cwd's first segment.
    configured = _scalar(CONFIG_YAML, "workspaces_root")
    if configured:
        root = Path(configured).expanduser().resolve()
        if root in cwd.parents:
            return root / cwd.relative_to(root).parts[0]
    # Walk up from cwd to nearest .git boundary; return its parent (the workspace).
    for d in [cwd, *cwd.parents]:
        if (d / ".git").exists():
            return d.parent
    return Path.home() / "workspace"


def check_unique(feature: str) -> bool:
    """Return True if feature name is NOT already allocated.

    Slot ownership lives in Docker container labels (see cli/lib/slots.py —
    ~/.sandbox/slots.json was removed in the labels migration). Best-effort:
    if docker is unreachable, don't block scaffolding.
    """
    try:
        result = subprocess.run(
            [
                "docker", "ps", "-a",
                "--format", '{{.Label "' + FEATURE_LABEL + '"}}',
                "--filter", f"label={FEATURE_LABEL}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return True
    if result.returncode != 0:
        return True
    return feature not in {line.strip() for line in result.stdout.splitlines() if line.strip()}


def scaffold_playwright_config(workspace: Path, base_url: str) -> bool:
    """Copy playwright.config.ts template to workspace if not present. Returns True if created."""
    dest = workspace / "playwright.config.ts"
    if dest.exists():
        return False
    template = (ASSETS_DIR / "playwright.config.ts.template").read_text()
    dest.write_text(template.replace("{{BASE_URL}}", base_url))
    return True


def scaffold_spec(feature: str, workspace: Path, base_url: str, cookie_domain: str) -> bool:
    """Copy feature spec template to workspace/<feature>.spec.ts if not present. Returns True if created."""
    dest = workspace / f"{feature}.spec.ts"
    if dest.exists():
        return False
    template = (ASSETS_DIR / "feature.spec.ts.template").read_text()
    dest.write_text(
        template
        .replace("{{FEATURE_NAME}}", feature)
        .replace("{{BASE_URL}}", base_url)
        .replace("{{COOKIE_DOMAIN}}", cookie_domain)
    )
    return True


def installed_playwright(workspace: Path) -> str | None:
    """The @playwright/test version node resolves from workspace, or None."""
    try:
        result = subprocess.run(
            ["node", "-p", "require('@playwright/test/package.json').version"],
            cwd=workspace, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def ensure_playwright(workspace: Path) -> None:
    """Install the pinned @playwright/test if absent; never replace a project's own version."""
    installed = installed_playwright(workspace)
    if installed == PLAYWRIGHT_VERSION:
        print(f"[info]  @playwright/test {installed} present")
        return
    if installed:
        print(
            f"[warn]  workspace pins @playwright/test {installed}, but `sandbox setup` installs "
            f"Chromium for {PLAYWRIGHT_VERSION} — if launch fails, run: "
            f"npx playwright@{installed} install chromium"
        )
        return
    # Spec imports resolve from the workspace, so `npx` alone cannot supply the package.
    cmd = ["npm", "install", "--save-dev", f"@playwright/test@{PLAYWRIGHT_VERSION}"]
    # resolve_workspace can land on the workspaces root (the workspace is itself a
    # git repo); never drop a package.json + node_modules there.
    if not (workspace / ".sandbox").is_dir():
        print(f"[error] {workspace} is not a sandbox workspace (no .sandbox/) — pass --workspace,", file=sys.stderr)
        print(f"[error] or install manually there: {' '.join(cmd)}", file=sys.stderr)
        sys.exit(1)
    try:
        rc = subprocess.run(cmd, cwd=workspace).returncode
    except OSError:
        rc = 127
    if rc != 0:
        print(f"[error] `{' '.join(cmd)}` failed in {workspace}", file=sys.stderr)
        sys.exit(1)
    print(f"[ok]    installed @playwright/test {PLAYWRIGHT_VERSION}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scaffold sandbox feature test files")
    parser.add_argument("--feature", required=True, help="Feature name (must be unique)")
    parser.add_argument("--workspace", help="Override workspace directory path")
    parser.add_argument(
        "--base-url",
        help="Override the ingress base URL (default: derived from ~/.sandbox config)",
    )
    args = parser.parse_args()

    feature = args.feature
    base_url, cookie_domain = resolve_ingress(args.base_url)

    # 1. Uniqueness check
    if not check_unique(feature):
        # Slot ownership moved to docker labels; ~/.sandbox/slots.json is gone.
        print(f"[error] Feature '{feature}' is already allocated (label {FEATURE_LABEL})", file=sys.stderr)
        print(f"[error] Choose a different name, or run: sandbox down {feature}", file=sys.stderr)
        sys.exit(1)

    # 2. Resolve workspace
    workspace = resolve_workspace(args.workspace)
    if not workspace.is_dir():
        print(f"[error] Workspace directory does not exist: {workspace}", file=sys.stderr)
        sys.exit(1)

    print(f"[info]  workspace: {workspace}")
    print(f"[info]  base URL:  {base_url}")

    # 3. Playwright config
    if scaffold_playwright_config(workspace, base_url):
        print(f"[ok]    created {workspace}/playwright.config.ts")
    else:
        print(f"[info]  playwright.config.ts already exists — skipping")

    # 4. Spec file
    if scaffold_spec(feature, workspace, base_url, cookie_domain):
        print(f"[ok]    created {workspace}/{feature}.spec.ts")
        print(f"[info]  edit the spec file to add feature-specific assertions")
    else:
        print(f"[info]  {feature}.spec.ts already exists — skipping")

    # 5. Test runner
    ensure_playwright(workspace)

    # Emit workspace path as the last line for easy capture by callers
    print(f"WORKSPACE_PATH={workspace}")


if __name__ == "__main__":
    main()
