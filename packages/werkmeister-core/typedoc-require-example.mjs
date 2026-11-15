// SW-750: TypeDoc can require a comment but not a tag, so docs:sdk loads this to fail on an SDK export with no @example.
import { readFileSync } from "node:fs";
import { Application, Comment, ReflectionKind } from "typedoc";

const TODO = "apps/docs-site/sdk-example-todo.txt";

/** `exports`: `{ id: "functions/foo", hasExample }` per SDK export; `todo`: the ids excused until SW-762. */
export function exampleProblems(exports, todo) {
  const byId = new Map(exports.map((e) => [e.id, e.hasExample]));
  return [
    ...exports
      .filter((e) => !e.hasExample && !todo.includes(e.id))
      .map((e) => `${e.id}: SDK export has no @example importing werkmeister-core/sdk`),
    ...todo.flatMap((id) =>
      !byId.has(id)
        ? [`${id}: listed in ${TODO} but not exported`]
        : byId.get(id)
          ? [`${id}: has an @example now; delete its line from ${TODO}`]
          : [],
    ),
  ];
}

export function load(app) {
  app.on(Application.EVENT_VALIDATE_PROJECT, (project) => {
    const exports = (project.children ?? []).map((r) => ({
      // The kind folder typedoc-plugin-markdown writes, so ids match the todo file's lines.
      id: `${ReflectionKind.pluralString(r.kind).toLowerCase().replaceAll(" ", "-")}/${r.name}`,
      // The import, not just the tag: sdk-examples.test.mjs type-checks only ```ts fences, so a bare `@example up()` would pass both.
      hasExample: Comment.combineDisplayParts(
        (r.comment ?? r.signatures?.[0]?.comment)?.getTag("@example")?.content ?? [],
      ).includes('from "werkmeister-core/sdk"'),
    }));
    // shortcut: exports added before their examples are excused by the todo list; delete this once SW-762 empties it.
    const todo = readFileSync(new URL(`../../${TODO}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    for (const p of exampleProblems(exports, todo)) app.logger.validationWarning(p);
  });
}
