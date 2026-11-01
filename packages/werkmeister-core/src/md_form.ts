/**
 * Markdown question forms (SW-309): a `## ` heading per question, `status: proposed | decided`,
 * `- ( )` pick one, `- [ ]` pick any, `(recommended)`, `Other:`, and an empty `**Label:**` text box.
 * The Markdown file is the source of truth. The JSON Schema bundle is only built in memory for
 * validation, and the writer changes only marks, Other text, empty labels and status lines.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { type FormBundle, type SchemaProp, validateFormData } from "./form_schema.js";

export type FormOption = {
  value: string;
  checked: boolean;
  recommended: boolean;
  other: boolean;
  otherText: string;
  line: number;
};
/** An empty `**Label:**` box; `**Label:** text` is context. */
export type FormBox = { label: string; line: number };
export interface FormQuestion {
  /** `q1`, `q2`, … in file order. */
  key: string;
  heading: string;
  required: boolean;
  status: "proposed" | "decided" | null;
  statusLine: number | null;
  /** Radio, checkbox, or no options. */
  kind: "one" | "any" | null;
  options: FormOption[];
  boxes: FormBox[];
  /** Every other non-blank line, as written. */
  context: string[];
}
export interface ParsedForm {
  title: string | null;
  questions: FormQuestion[];
}
/** Per question key: picked option values, the Other text, and box text by label. */
export type FormAnswers = Record<
  string,
  { picked?: string[]; other?: string; boxes?: Record<string, string> }
>;

const H1 = /^# (.*)$/;
const H2 = /^## (.*)$/;
const STATUS = /^status:\s*(proposed|decided)$/;
const OPTION = /^- (?:\(([ xX])\)|\[([ xX])\]) (.*)$/;
const BOX = /^\*\*([^*]+):\*\*$/;
const RECOMMENDED = " (recommended)";
const OPTIONAL = /\s*\(optional\)$/;
const OTHER = /^Other:(.*)$/;

export function parseForm(md: string): ParsedForm {
  const lines = md.split("\n");
  let title: string | null = null;
  const questions: FormQuestion[] = [];
  let q: FormQuestion | null = null;
  // Options are the contiguous `- ` lines from the first one; anything else ends the list.
  let listState: "before" | "in" | "after" = "before";
  lines.forEach((raw, i) => {
    const t = raw.trimEnd();
    const h2 = H2.exec(t);
    if (h2 || H1.test(t)) {
      if (!h2) {
        title ??= (H1.exec(t) as RegExpExecArray)[1] as string;
        q = null;
        return;
      }
      const text = h2[1] as string;
      q = {
        key: `q${questions.length + 1}`,
        heading: text.replace(OPTIONAL, ""),
        required: !OPTIONAL.test(text),
        status: null,
        statusLine: null,
        kind: null,
        options: [],
        boxes: [],
        context: [],
      };
      questions.push(q);
      listState = "before";
      return;
    }
    const cur = q as FormQuestion | null;
    if (!cur || t === "") {
      if (listState === "in") listState = "after";
      return;
    }
    const status = STATUS.exec(t);
    if (status && cur.statusLine === null) {
      cur.status = status[1] as "proposed" | "decided";
      cur.statusLine = i;
      if (listState === "in") listState = "after";
      return;
    }
    const opt = OPTION.exec(t);
    const kind = opt ? (opt[1] !== undefined ? "one" : "any") : null;
    if (opt && listState !== "after" && (cur.kind === null || cur.kind === kind)) {
      cur.kind = kind;
      listState = "in";
      let value = opt[3] as string;
      const recommended = value.endsWith(RECOMMENDED);
      if (recommended) value = value.slice(0, -RECOMMENDED.length);
      const other = OTHER.exec(value);
      cur.options.push({
        value: other ? "Other" : value,
        checked: (opt[1] ?? opt[2]) !== " ",
        recommended,
        other: other !== null,
        otherText: other ? (other[1] as string).trim() : "",
        line: i,
      });
      return;
    }
    if (listState === "in") listState = "after";
    const box = BOX.exec(t);
    if (box) cur.boxes.push({ label: box[1] as string, line: i });
    else cur.context.push(t);
  });
  return { title, questions };
}

const open = (form: ParsedForm) => form.questions.filter((q) => q.status === "proposed");

/** The file's own state for each proposed question; nothing ticked → its `(recommended)` options. */
export function formDraft(form: ParsedForm): FormAnswers {
  const out: FormAnswers = {};
  for (const q of open(form)) {
    let picked = q.options.filter((o) => o.checked).map((o) => o.value);
    if (!picked.length) {
      picked = q.options.filter((o) => o.recommended).map((o) => o.value);
      if (q.kind === "one") picked = picked.slice(0, 1);
    }
    const other = q.options.find((o) => o.other);
    out[q.key] = {
      picked,
      ...(other ? { other: other.otherText } : {}),
      boxes: Object.fromEntries(q.boxes.map((b) => [b.label, ""])),
    };
  }
  return out;
}

/** The in-memory bundle `validateFormData` checks: one key per proposed question, its Other text and boxes. */
export function formBundle(form: ParsedForm): FormBundle {
  const properties: Record<string, SchemaProp> = {};
  const required: string[] = [];
  const order: string[] = [];
  const uiSchema: Record<string, unknown> = {};
  for (const q of open(form)) {
    const values = q.options.map((o) => o.value);
    if (q.kind === "one") properties[q.key] = { title: q.heading, type: "string", enum: values };
    if (q.kind === "any")
      properties[q.key] = {
        title: q.heading,
        type: "array",
        items: { type: "string", enum: values },
        uniqueItems: true,
      };
    if (q.kind) order.push(q.key);
    if (q.kind === "one" && q.required) required.push(q.key);
    if (q.options.some((o) => o.other)) {
      properties[`${q.key}.other`] = { title: "Other", type: "string" };
      order.push(`${q.key}.other`);
    }
    for (const b of q.boxes) {
      const k = `${q.key}.${b.label}`;
      properties[k] = { title: b.label, type: "string" };
      uiSchema[k] = { "ui:widget": "textarea" };
      order.push(k);
      if (q.kind === null && q.required) required.push(k);
    }
  }
  uiSchema["ui:order"] = order;
  const title = form.title ?? "Questions";
  return { schema: { type: "object", title, properties, required }, uiSchema, formData: {}, title };
}

/** Field key → why `answers` can't be submitted; empty when they can. */
export function formErrors(form: ParsedForm, answers: FormAnswers): Record<string, string> {
  const byKey = new Map(open(form).map((q) => [q.key, q]));
  const formData: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, a] of Object.entries(answers)) {
    const q = byKey.get(key);
    if (!q) {
      errors[key] = "not a proposed question";
      continue;
    }
    const picked = a.picked ?? [];
    if (q.kind === "one" && picked.length > 1) errors[key] = "pick one";
    formData[key] = q.kind === "one" ? (picked[0] ?? "") : picked;
    if (a.other !== undefined) formData[`${key}.other`] = a.other;
    for (const [label, v] of Object.entries(a.boxes ?? {})) formData[`${key}.${label}`] = v;
    if (picked.includes("Other") && !(a.other ?? "").trim()) errors[`${key}.other`] = "required";
  }
  return { ...validateFormData(formBundle(form), formData), ...errors };
}

/**
 * `md` with each answered proposed question written in: marks, Other text, box text and
 * `status: decided`. Every other byte is kept; `{}` returns `md` itself.
 */
export function applyAnswers(md: string, answers: FormAnswers): string {
  const lines = md.split("\n");
  const after = new Map<number, string[]>();
  // A line's `\r` (CRLF files) stays at its end.
  const cr = (i: number) => ((lines[i] as string).endsWith("\r") ? "\r" : "");
  const body = (i: number) =>
    (lines[i] as string).slice(0, (lines[i] as string).length - cr(i).length);
  for (const q of open(parseForm(md))) {
    const a = answers[q.key];
    if (!a) continue;
    if (a.picked) {
      for (const o of q.options) {
        const want = a.picked.includes(o.value);
        if (want === o.checked) continue;
        const l = lines[o.line] as string;
        lines[o.line] = `${l.slice(0, 3)}${want ? "x" : " "}${l.slice(4)}`;
      }
    }
    const other = q.options.find((o) => o.other);
    const otherPicked = other && (a.picked ? a.picked.includes(other.value) : other.checked);
    if (other && otherPicked && a.other !== undefined && a.other.trim() !== other.otherText) {
      const b = body(other.line);
      const text = a.other.replace(/\s+/g, " ").trim();
      const tail = other.recommended ? RECOMMENDED : "";
      lines[other.line] =
        `${b.slice(0, b.indexOf("Other:") + 6)}${text ? ` ${text}` : ""}${tail}${cr(other.line)}`;
    }
    for (const box of q.boxes) {
      const text = (a.boxes?.[box.label] ?? "").trimEnd();
      if (!text.trim()) continue;
      const [first, ...rest] = text.split("\n");
      lines[box.line] = `${body(box.line).trimEnd()} ${first}${cr(box.line)}`;
      after.set(
        box.line,
        rest.map((r) => `${r}${cr(box.line)}`),
      );
    }
    if (q.statusLine !== null) {
      lines[q.statusLine] = (lines[q.statusLine] as string).replace("proposed", "decided");
    }
  }
  return lines.flatMap((l, i) => [l, ...(after.get(i) ?? [])]).join("\n");
}

export function formHash(md: string): string {
  return createHash("sha256").update(md).digest("hex");
}

/** A mid-stage question or stage-end approval form: never a stage's own artifact. */
export function isQuestionFile(name: string): boolean {
  return /^question-.+\.md$/.test(name);
}

/**
 * Write `answers` into `file` and flip every proposed question to decided. Refuses, writing
 * nothing, when the file changed since it was rendered (`renderedHash`) or an answer is invalid.
 */
export async function submitForm(
  file: string,
  answers: FormAnswers,
  renderedHash: string,
): Promise<{ file: string; decided: string[] }> {
  const md = await fs.readFile(file, "utf-8");
  if (formHash(md) !== renderedHash) {
    throw new Error(`${file} changed after the form was shown; reload the form`);
  }
  const form = parseForm(md);
  const errors = Object.entries(formErrors(form, answers));
  if (errors.length) throw new Error(errors.map(([k, v]) => `${k}: ${v}`).join("\n"));
  const pending = open(form);
  const all: FormAnswers = Object.fromEntries(pending.map((q) => [q.key, answers[q.key] ?? {}]));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, applyAnswers(md, all));
  await fs.rename(tmp, file);
  return { file, decided: pending.map((q) => q.heading) };
}
