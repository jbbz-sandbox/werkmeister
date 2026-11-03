// SW-377: the install-check hooks ship with the plugin; `werkmeister machine setup` retires the
// hand-copied command hooks in ~/.claude/settings.json and names the leftover skill folder.
// Paths are injected; nothing here reads the real HOME.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const { LEGACY_INSTALL_CHECK, legacyInstallCheckState, syncLegacyInstallCheck } = await import(
  "./dist/machine_setup.js"
);

const LEGACY_SETTINGS = `{
  // kept as the person wrote it
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/r/plugins/werkmeister" },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "bash ~/.claude/skills/werkmeister-install-check/session-start.sh", "timeout": 90 }
        ]
      },
      { "hooks": [{ "type": "command", "command": "echo other" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash ~/.claude/skills/werkmeister-install-check/prompt-gate.sh" }] }
    ]
  }
}
`;

let dir;
let settings;
let skills;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-check-retire-"));
  settings = path.join(dir, "settings.json");
  skills = path.join(dir, "skills");
  fs.mkdirSync(skills);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("fix removes only the legacy hooks and keeps the rest of the file", () => {
  fs.writeFileSync(settings, LEGACY_SETTINGS);
  const steps = syncLegacyInstallCheck(false, settings, skills);
  assert.deepEqual(
    steps.map((s) => [s.ok, s.detail]),
    [[true, `removed from ${settings}: SessionStart, UserPromptSubmit`]],
  );
  const text = fs.readFileSync(settings, "utf8");
  assert.match(text, /kept as the person wrote it/);
  assert.match(text, /CLAUDE_CODE_PLUGIN_DIRS/);
  const after = JSON.parse(text.replace(/^\s*\/\/.*$/m, ""));
  assert.deepEqual(after.hooks, {
    SessionStart: [{ hooks: [{ type: "command", command: "echo other" }] }],
  });
  assert.deepEqual(legacyInstallCheckState(settings, skills).hookEvents, []);
  // A second run has nothing to retire: no step.
  assert.deepEqual(syncLegacyInstallCheck(false, settings, skills), []);
});

test("fix drops the hooks key when nothing else is hooked", () => {
  fs.writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "bash ~/.claude/skills/werkmeister-install-check/prompt-gate.sh",
              },
            ],
          },
        ],
      },
    }),
  );
  syncLegacyInstallCheck(false, settings, skills);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), {});
});

test("check-only reports the drift and leaves the file alone", () => {
  fs.writeFileSync(settings, LEGACY_SETTINGS);
  const steps = syncLegacyInstallCheck(true, settings, skills);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].ok, false);
  assert.equal(steps[0].optional, undefined);
  assert.match(steps[0].detail, /SessionStart, UserPromptSubmit/);
  assert.equal(fs.readFileSync(settings, "utf8"), LEGACY_SETTINGS);
});

test("nothing to retire is no step; a missing settings file is fine", () => {
  assert.deepEqual(syncLegacyInstallCheck(false, settings, skills), []);
  fs.writeFileSync(
    settings,
    '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }',
  );
  assert.deepEqual(syncLegacyInstallCheck(true, settings, skills), []);
});

test("the leftover skill folder is a warning naming the path, never removed", () => {
  const folder = path.join(skills, LEGACY_INSTALL_CHECK);
  fs.mkdirSync(folder);
  const steps = syncLegacyInstallCheck(false, settings, skills);
  assert.deepEqual(
    steps.map((s) => [s.ok, s.optional]),
    [[false, true]],
  );
  assert.match(steps[0].detail, new RegExp(`rm -rf ${folder}`));
  assert.ok(fs.existsSync(folder));
});

test("an unparsable settings file is an optional failure", () => {
  fs.writeFileSync(settings, "{ nope");
  const steps = syncLegacyInstallCheck(false, settings, skills);
  assert.deepEqual(
    steps.map((s) => [s.ok, s.optional]),
    [[false, true]],
  );
  assert.equal(fs.readFileSync(settings, "utf8"), "{ nope");
});
