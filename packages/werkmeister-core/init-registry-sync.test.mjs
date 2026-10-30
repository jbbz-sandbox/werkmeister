// SW-196: a fragment change merged to a repo's main reached new workspaces only
// after someone ran `werkmeister registry sync` by hand. init-workspace now
// regenerates the registry first — unless it is hand-written, which it leaves alone.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { syncRegistry } from "./dist/registry_sync.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { withSandboxHome } from "./fixtures.mjs";

const fragment = (validate) =>
  `services:\n  backend:\n    type: api\n    port_offset: 2\n    validate: ${validate}\n`;

/** Registry generated from OLD-TEXT, then the fragment changes with no sync; returns init's context and output. */
async function initAfterFragmentChange({ handWritten }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "init-registry-"));
  const repos = path.join(tmp, "repos");
  const fragmentFile = path.join(repos, "demo-repo", ".werkmeister", "services.yaml");
  fs.mkdirSync(path.join(repos, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.dirname(fragmentFile));
  const ws = path.join(tmp, "features", "demo-ws");
  fs.mkdirSync(path.join(ws, "demo-repo", ".git"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "workspace.yml"),
    "task: Registry test\nwork_type: bug\nfeature: demo\nservices: backend\ncontext_strategy: icm\n",
  );
  try {
    return await withSandboxHome(
      async () => {
        const registry = path.join(
          path.dirname(process.env.WERKMEISTER_CONFIG_FILE),
          "services.yaml",
        );
        fs.writeFileSync(fragmentFile, fragment("OLD-TEXT"));
        if (handWritten) {
          fs.writeFileSync(
            registry,
            fragment("OLD-TEXT").replace("api", "api\n    repo: demo-repo"),
          );
        } else {
          fs.rmSync(registry);
          assert.equal(syncRegistry()[0].ok, true);
        }
        fs.writeFileSync(fragmentFile, fragment("NEW-TEXT"));
        const collector = collectingReporter();
        await withReporter(collector, () => initWorkspace({}, ws, { build: false }));
        return {
          context: fs.readFileSync(path.join(ws, ".werkmeister", "werkmeister-context.md"), "utf8"),
          registry: fs.readFileSync(registry, "utf8"),
          output: collector.text(),
        };
      },
      {
        config: `paths:\n  repos_root: ${repos}\n  workspaces_root: ${path.dirname(ws)}\n`,
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("init renders a fragment change made after the last sync, with no manual sync", async () => {
  const { context, registry } = await initAfterFragmentChange({ handWritten: false });
  assert.match(context, /NEW-TEXT/);
  assert.doesNotMatch(context, /OLD-TEXT/);
  assert.match(registry, /NEW-TEXT/);
});

test("init leaves a hand-written registry as is and says so", async () => {
  const { context, registry, output } = await initAfterFragmentChange({ handWritten: true });
  assert.match(context, /OLD-TEXT/);
  assert.doesNotMatch(registry, /NEW-TEXT/);
  assert.match(output, /Registry not refreshed: .*hand-written/);
});
