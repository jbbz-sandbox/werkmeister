// SW-750: TypeDoc can require a comment but not a tag, so docs:sdk loads this to fail on an SDK export with no @example.
import { Application, Comment, ReflectionKind } from "typedoc";

/** `exports`: `{ id: "functions/foo", hasExample }` per SDK export. */
export function exampleProblems(exports) {
  return exports
    .filter((e) => !e.hasExample)
    .map((e) => `${e.id}: SDK export has no @example importing werkmeister-core/sdk`);
}

export function load(app) {
  app.on(Application.EVENT_VALIDATE_PROJECT, (project) => {
    const exports = (project.children ?? []).map((r) => ({
      // The kind folder typedoc-plugin-markdown writes, matching the rendered page's path.
      id: `${ReflectionKind.pluralString(r.kind).toLowerCase().replaceAll(" ", "-")}/${r.name}`,
      // The import, not just the tag: sdk-examples.test.mjs type-checks only ```ts fences, so a bare `@example up()` would pass both.
      hasExample: Comment.combineDisplayParts(
        (r.comment ?? r.signatures?.[0]?.comment)?.getTag("@example")?.content ?? [],
      ).includes('from "werkmeister-core/sdk"'),
    }));
    for (const p of exampleProblems(exports)) app.logger.validationWarning(p);
  });
}
