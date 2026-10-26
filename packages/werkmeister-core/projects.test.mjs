// `projects:` in config.yaml (SW-104): each valid project loads; each invalid one is
// named with why, for `sandbox config --check`, and left out.

import assert from "node:assert/strict";
import { test } from "node:test";

const { loadProjects, projectProblems } = await import("./dist/projects.js");

const yaml = (await import("yaml")).default;
const cfg = (text) => yaml.parse(text);

test("the documented example loads, sorted by name, keys upper-cased", () => {
  const c = cfg(`
projects:
  werkmeister:
    tracker: { id: jira, project: sw }
    board: { id: 42, ready: Selected for Development }
    issue_statuses: { in_review: In Review }
    default: true
  acme:
    tracker: { id: github, org: acme, repos: [acme/web, acme/api] }
`);
  assert.deepEqual(projectProblems(c), []);
  assert.deepEqual(loadProjects(c), [
    {
      name: "acme",
      tracker: "github",
      scope: { org: "acme", repos: ["acme/web", "acme/api"] },
      issueStatuses: {},
      default: false,
    },
    {
      name: "werkmeister",
      tracker: "jira",
      scope: { project: "SW" },
      board: { id: "42", ready: "Selected for Development" },
      issueStatuses: { in_review: "In Review" },
      default: true,
    },
  ]);
});

test("no projects: is no projects and no problems", () => {
  assert.deepEqual(loadProjects({}), []);
  assert.deepEqual(projectProblems({ overrides: { issue_tracker: "github" } }), []);
});

test("each fault is named; only the valid project loads", () => {
  const c = cfg(`
projects:
  Bad_Name: { tracker: { id: jira, project: SW } }
  unknown: { tracker: { id: linear } }
  nokey: { tracker: { id: jira } }
  noorg: { tracker: { id: github } }
  badrepos: { tracker: { id: github, org: o, repos: [web] } }
  noready: { tracker: { id: jira, project: SW }, board: { id: 1 } }
  ok: { tracker: { id: jira, project: SW }, default: true }
  ok2: { tracker: { id: github, org: o }, default: true }
`);
  assert.deepEqual(projectProblems(c), [
    "projects.Bad_Name: name must be lowercase letters, digits and single hyphens",
    "projects.badrepos: tracker.repos must be a list of owner/repo",
    "projects.nokey: tracker.project must be a Jira project key (e.g. SW)",
    "projects.noorg: tracker.org must name the GitHub owner",
    "projects.noready: board needs both id and ready",
    "projects.unknown: tracker.id must be one of jira, github",
    "projects: only one project may set default: true (ok, ok2)",
  ]);
  assert.deepEqual(
    loadProjects(c).map((p) => p.name),
    ["ok", "ok2"],
  );
});
