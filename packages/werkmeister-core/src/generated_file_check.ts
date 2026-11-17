/** The three checks a run makes before filing a bug about a generated file; a leaf module so the issues guide and the ICM review step can share it without an import cycle. */

import { COMPOSE_FILE } from "./compose_file.js";

// SW-844: sw-773 filed SW-835 against werkmeister for a settings.json edit the person had made by hand.
export const generatedFileCheck = (tool?: string) =>
  `Before filing a bug about a generated file (\`.claude/settings.json\`, \`.werkmeister/*\`, \`${COMPOSE_FILE}\`, \`.env\`) that changed outside this run's own edits, check three things and file only if they still point at werkmeister: ` +
  "(1) compare it with its record where one exists (`.werkmeister/claude-permissions.json` for the permission rules and model werkmeister merges in; hook entries are not recorded) and say whether the record changed too — werkmeister rewrites the record whenever it changes what it merges in, so a recorded rule or model missing from the file while the record is unchanged was not removed by werkmeister; " +
  "(2) compare the file's mtime with this session's own activity: was any of its commands running then? " +
  `(3) Ask the person${tool ? ` through \`${tool}\`` : ""} whether they edited it, before naming a werkmeister writer.`;
