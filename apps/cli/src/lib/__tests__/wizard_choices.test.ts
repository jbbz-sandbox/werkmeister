/** The Inquirer-backed prompts: select / checkbox, plus the typed fallbacks. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

let selected: unknown;
let fault: Error | null = null;
let checked: string[];
const typed: string[] = [];
/** What the prompt mocks receive: Inquirer config, with `choices` for select / checkbox. */
type PromptConfig = {
  choices?: { value?: unknown; checked?: boolean; separator?: string }[];
  [key: string]: unknown;
};
const seen: (PromptConfig & { kind: string })[] = [];
const record = (kind: string, config: PromptConfig) => seen.push({ kind, ...config });

vi.mock("@inquirer/prompts", () => ({
  Separator: class {
    constructor(public separator: string) {}
  },
  select: async (config: PromptConfig) => {
    record("select", config);
    if (fault) {
      const thrown = fault;
      fault = null;
      throw thrown;
    }
    // "Other" is the last entry; the test asks for it by name, not by symbol.
    return selected === "OTHER" ? config.choices?.at(-1)?.value : selected;
  },
  checkbox: async (config: PromptConfig) => {
    record("checkbox", config);
    return checked;
  },
  input: async (config: PromptConfig) => {
    record("input", config);
    return typed.shift() ?? "";
  },
  editor: async (config: PromptConfig) => {
    record("editor", config);
    return typed.shift() ?? "";
  },
  password: async (config: PromptConfig) => {
    record("password", config);
    return typed.shift() ?? "";
  },
  confirm: async (config: PromptConfig) => {
    record("confirm", config);
    return typed.shift() === "y";
  },
}));

// The non-TTY path still goes through readline.
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    on: () => {},
    close: () => {},
    question: async () => typed.shift() ?? "",
  }),
}));

const { confirm, fieldsOf, prompt, promptOne } = await import("../wizard.js");

const SPEC = { key: "work_type", label: "Work type", help: "h" };
const MULTI = { key: "services", label: "Services", help: "h", multi: true };

describe("the Inquirer-backed prompts", () => {
  const tty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  afterEach(() => {
    seen.length = 0;
    typed.length = 0;
    fault = null;
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  it("returns the selected value and pre-selects the default", async () => {
    selected = "bugfix";
    expect(await promptOne(SPEC, "feature", ["feature", "bugfix"])).toBe("bugfix");
    expect(seen[0].default).toBe("feature");
  });

  it("ignores a default that isn't one of the choices", async () => {
    selected = "feature";
    await promptOne(SPEC, "nonsense", ["feature", "bugfix"]);
    expect(seen[0].default).toBeUndefined();
  });

  it("'Other' falls back to typing, and the pattern still guards it", async () => {
    selected = "OTHER";
    typed.push("bogus type", "chore");
    expect(await promptOne({ ...SPEC, pattern: "^[a-z]+$" }, "", ["feature"])).toBe("chore");
  });

  it("multi-value checks the current selection and returns it comma-joined", async () => {
    checked = ["api", "web"];
    expect(await promptOne(MULTI, "web", ["api", "web", "worker"])).toBe("api,web");
    expect(seen[0].choices?.filter((c) => c.checked).map((c) => c.value)).toEqual(["web"]);
  });

  it("multi-value lists choices under their group headings, ungrouped last", async () => {
    checked = [];
    const groups = { "repo-a": ["web", "worker"], "repo-b": ["api"] };
    await promptOne({ ...MULTI, groups }, "", ["api", "cron", "web", "worker"]);
    expect(seen[0].choices?.map((c) => c.separator ?? c.value)).toEqual([
      "── repo-a ──",
      "web",
      "worker",
      "── repo-b ──",
      "api",
      "── other ──",
      "cron",
    ]);
  });

  it("reads fields off the form schema bundle the browser form renders", async () => {
    const { buildFormSchema } = await import("sandbox-core/form_schema");
    const bundle = buildFormSchema({
      prompts: [
        {
          key: "feature",
          label: "Feature",
          accept_empty: false,
          pattern: "^[a-z]+$",
          default: "blog",
        },
        {
          key: "services",
          label: "Services",
          multi: true,
          choices: ["api", "web"],
          choice_groups: { r: ["api", "web"] },
          default: "web",
        },
        {
          key: "starting_prompt",
          label: "Prompt",
          multiline: true,
          refinable: true,
          refine_instruction: "tidy",
        },
        { key: "done", label: "Done", resolved: true, resolved_value: "x" },
      ],
    });
    const fields = fieldsOf(bundle);
    expect(fields.map((f) => f.key)).toEqual(["feature", "services", "starting_prompt"]);
    expect(fields[0]).toMatchObject({
      required: true,
      pattern: "^[a-z]+$",
      default: "blog",
      multi: false,
    });
    expect(fields[1]).toMatchObject({
      multi: true,
      choices: ["api", "web"],
      groups: { r: ["api", "web"] },
      default: "web",
    });
    expect(fields[2]).toMatchObject({
      multiline: true,
      refinable: true,
      refineInstruction: "tidy",
      required: false,
    });
  });

  it("off a TTY it types instead, so piped answers still work", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    typed.push("bugfix");
    expect(await promptOne(SPEC, "feature", ["feature", "bugfix"])).toBe("bugfix");
    expect(seen).toHaveLength(0);
  });

  it("an empty answer keeps the default, typed or piped", async () => {
    expect(await prompt("Feature", "mdx-blog")).toBe("mdx-blog");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    expect(await prompt("Feature", "mdx-blog")).toBe("mdx-blog");
  });

  // Inquirer returns the raw line; untrimmed, a trailing space fails the
  // anchored pattern check or lands in config.yaml verbatim.
  it("trims what was typed, and treats whitespace-only as empty", async () => {
    typed.push("  mdx-blog  ", "   ");
    expect(await prompt("Feature")).toBe("mdx-blog");
    expect(await prompt("Feature", "fallback")).toBe("fallback");
  });

  it("secret inputs are masked and never carry a visible default", async () => {
    typed.push("token-123");
    expect(await prompt("API token", "old-token", { secret: true })).toBe("token-123");
    expect(seen[0]).toMatchObject({ kind: "password", mask: true });
    expect(seen[0].default).toBeUndefined();
  });

  it("multiline prose opens $EDITOR pre-filled, and trims the saved buffer", async () => {
    vi.stubEnv("EDITOR", "nano");
    typed.push("  Ship the blog index.\n\n- [ ] /blog renders\n  ");
    const spec = { key: "starting_prompt", label: "Starting prompt", help: "h", multiline: true };
    expect(await promptOne(spec, "draft", null)).toBe(
      "Ship the blog index.\n\n- [ ] /blog renders",
    );
    expect(seen[0]).toMatchObject({ kind: "editor", default: "draft", postfix: ".md" });
  });

  it("with no editor configured it stays on the single-line input", async () => {
    vi.stubEnv("EDITOR", "");
    vi.stubEnv("VISUAL", "");
    typed.push("one-liner");
    const spec = { key: "starting_prompt", label: "Starting prompt", help: "h", multiline: true };
    expect(await promptOne(spec, "", null)).toBe("one-liner");
    expect(seen[0].kind).toBe("input");
  });

  // A bare `catch { exit(130) }` would report any fault as a clean Ctrl-C,
  // killing the process with an exit code that blames the user for a bug.
  it("a real fault propagates instead of masquerading as Ctrl-C", async () => {
    fault = new TypeError("choices is not iterable");
    await expect(promptOne(SPEC, "", ["feature"])).rejects.toThrow("not iterable");
    fault = Object.assign(new Error("User force closed"), { name: "ExitPromptError" });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await promptOne(SPEC, "", ["feature"]);
    expect(exit).toHaveBeenCalledWith(130);
    exit.mockRestore();
  });

  it("confirm offers the fallback and uses it verbatim when nobody can answer", async () => {
    typed.push("y");
    expect(await confirm("Seed the demo apps?", false)).toBe(true);
    expect(seen[0]).toMatchObject({ kind: "confirm", default: false });
    seen.length = 0;
    expect(await confirm("Seed the demo apps?", true, false)).toBe(true);
    expect(seen).toHaveLength(0);
  });

  afterAll(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  });
});
