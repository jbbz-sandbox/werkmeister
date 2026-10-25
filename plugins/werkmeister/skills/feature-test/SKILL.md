---
name: feature-test
description: "Start a developer sandbox feature environment and open a headed browser for interactive testing. Use when the user says '/werkmeister:feature-test', 'start feature NAME', 'spin up feature NAME', 'test my feature', or any request to bring up a named sandbox feature and run or open a browser test against the sandbox ingress host. Feature names must be unique (not already running in the sandbox)."
---

# Sandbox Feature Test

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename keeps `~/.sandbox/` or `.sandbox/` instead; use whichever exists.

Spins up a named sandbox feature, scaffolds test files if needed, and opens a headed Playwright browser paused at the home page for interactive inspection.

## Prerequisites

- `sandbox` CLI on PATH (its checkout is `paths.sandbox_root` in `~/.werkmeister/config.yaml`)
- `npx` / Node.js available
- `sandbox setup` run once on this machine — it downloads the Chromium build for the pinned Playwright (`sandbox test --scaffold` installs the matching `@playwright/test` in the workspace)
- Shared infra may or may not be running — this skill ensures it is

## Routing model (important)

This skill is for front-door services (those with a `feature_router:`). A library, CLI or extension has no URL; follow the "How to validate" section of `.werkmeister/sandbox-context.md` instead.

The ingress host is configured per machine, not hardcoded here: it derives from
`ingress.local_domain` in `~/.werkmeister/config.yaml` joined to a service that
declares a `feature_router:` block in `~/.werkmeister/services.yaml`. `sandbox setup`
owns those values, and `sandbox test --scaffold` resolves them when it scaffolds the
test files (override with `--base-url`).

Every request to that host is routed to a feature's containers via:
- **HTTP header**: `X-Feature: <feature>` (set in `playwright.config.ts`)
- **Cookie**: `X-Feature=<feature>` on `.<local_domain>` (set in the spec file)

Both are required: the header covers Playwright requests; the cookie covers browser-initiated navigations.

## Workflow

### Step 1 — Get the feature name

If the user has not provided a feature name, ask for one. Feature names must:
- Be lowercase, hyphen-separated (e.g., `add-solutions-panel`, `payment-refactor`)
- Not already be allocated (collision = already running). Slot ownership lives in
  the `com.werkmeister.feature` docker label; `~/.werkmeister/slots.json` is gone.

### Step 2 — Validate and scaffold

```bash
sandbox test <feature-name> --scaffold
```

This will:
- Exit non-zero if the feature name is already allocated → stop and tell the user
- Create `playwright.config.ts` in the workspace if missing
- Create `<feature>.spec.ts` in the workspace if missing
- Print `WORKSPACE_PATH=<path>` as the last line — capture this

Parse `WORKSPACE_PATH` from the output. All subsequent file operations and test runs use this path.

### Step 3 — Ensure shared infrastructure

```bash
sandbox connect
```

This is idempotent — safe to run even if infra is already up. It starts Caddy and the k8s port-forwards, plus Jaeger and RedisInsight when `infra.profiles` in `~/.werkmeister/config.yaml` enables them.

### Step 4 — Start feature containers

```bash
sandbox up <feature-name>
```

Starts containers only for the services in the workspace's `.env` `SERVICES=` list (from `workspace.yml`'s `services`). The rest are forwarded from k8s. Wait for the command to complete before proceeding.

### Step 5 — Run the test

```bash
cd <WORKSPACE_PATH> && SANDBOX_FEATURE=<feature-name> npx playwright test <feature-name>.spec.ts --headed
```

Do NOT use `sandbox test` (without `--scaffold`) here — run `npx playwright test` directly to ensure `--headed` is passed correctly.

The test will:
1. Set the `X-Feature` cookie on `.<local_domain>`
2. Navigate to the resolved base URL (printed by `sandbox test --scaffold` as `base URL:`)
3. Call `page.pause()` → Playwright Inspector opens, browser stays open

The terminal will block until the developer closes the Inspector or presses Resume. This is expected.

## Scaffolded file guidance

The auto-generated `<feature>.spec.ts` is intentionally minimal — a `page.pause()` placeholder for interactive exploration. Developers are encouraged to **write the real spec file before running this skill**, using the generated file as a structural reference.

Key patterns already in the template:
- Cookie is set before `page.goto('/')` to ensure routing works on first navigation
- `X-Feature` header is set globally in `playwright.config.ts` via `extraHTTPHeaders`
- `ignoreHTTPSErrors: true` handles the self-signed local cert

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Feature 'X' already allocated` | Name collision with running feature | Choose different name or `sandbox down X` |
| Browser shows wrong feature | Cookie not set before `goto` | Ensure `addCookies` runs before `page.goto` |
| HTTP 502 or connection refused | Feature containers not healthy yet | Wait ~30s and retry, or check `sandbox status` |
| `npx: command not found` | Node.js not on PATH in this shell | Add Node.js to PATH or use full path |
| `Executable doesn't exist at .../ms-playwright/chromium-NNNN` | Chromium for this Playwright version not downloaded | Re-run `sandbox setup`; if the workspace pins its own `@playwright/test`, run `npx playwright install chromium` in it |
