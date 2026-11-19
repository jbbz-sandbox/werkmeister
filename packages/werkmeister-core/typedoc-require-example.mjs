// SW-750: TypeDoc can require a comment but not a tag, so docs:sdk loads this to fail on an SDK export with no @example.
// SW-883: and on a Jira key in an SDK comment, which docs-site renders into its SDK pages; docs:sdk runs in the gate's lint row.
import { Application, Comment, ReflectionKind } from "typedoc";

/** `exports`: `{ id: "functions/foo", hasExample }` per SDK export. */
export function exampleProblems(exports) {
  return exports
    .filter((e) => !e.hasExample)
    .map((e) => `${e.id}: SDK export has no @example importing werkmeister-core/sdk`);
}

/** `comments`: `{ id, text }` per SDK comment. A key may stay in a code span or as a link, as docs-render.test.mjs allows. */
export function jiraKeyProblems(comments) {
  return comments.flatMap(({ id, text }) => {
    const keys = text
      .replace(/`[^`]*`/g, "")
      .replace(/\[[^\]]*\]\([^)]*\)/g, "")
      .match(/\bSW-\d+\b/g);
    return keys
      ? [`${id}: Jira key ${keys.join(", ")} in an SDK comment; readers can't open the tracker`]
      : [];
  });
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
    // Every reflection, so a member's or a parameter's comment counts too (SW-883: an option's).
    const comments = project
      .getReflectionsByKind(ReflectionKind.All)
      .filter((r) => r.comment)
      .map((r) => ({
        id: r.getFullName(),
        // @example fences are code, rendered as fences docs-render skips.
        text: [
          r.comment.summary,
          ...r.comment.blockTags.filter((t) => t.tag !== "@example").map((t) => t.content),
        ]
          .map((parts) => Comment.combineDisplayParts(parts))
          .join("\n"),
      }));
    for (const p of jiraKeyProblems(comments)) app.logger.validationWarning(p);
  });
}
