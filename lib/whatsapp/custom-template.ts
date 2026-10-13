// ---------------------------------------------------------------------------
// A merchant's own WhatsApp template (docs/whatsapp-commerce-plan.md §4
// Templates: the template manager). Pure and client-safe: the editor and the
// submit action check one shape, and the inbox composer reads the same
// components back.
//
// ── ★ WHAT A MERCHANT MAY AUTHOR, AND WHY NO MORE ──────────────────────────
// A text header, a body with {{n}} placeholders (each with a label and a
// sample for Meta's review), a footer, and up to three buttons: quick reply,
// a website link, or a phone number. Everything here can be sent from the
// inbox with the body's values alone, because nothing in it needs a value at
// send time: a static link, a static number, a quick reply whose tap carries
// its own label. A header picture, a link with a variable in it, a copy-code
// button or a carousel each need a send-time parameter the composer has no
// field for, so they are not offered rather than offered and refused on Send.
//
// ── ★ THE BODY RULES ARE THE CATALOGUE'S ───────────────────────────────────
// templateBodyProblem (template-catalog.ts) is the one list of what Meta
// refuses at review; the catalogue test asserts every StoreMink template
// passes it and this validator asks it the same question, so a merchant hears
// the reason here instead of from Meta's error a day later.
//
// ── ★ QUICK REPLIES COME FIRST ─────────────────────────────────────────────
// A quick-reply button is sent with a payload matched to the button by its
// INDEX among all the template's buttons (graph.ts). Meta requires quick
// replies to be grouped, and keeping them first means the payload list the
// composer builds lines up with the first N buttons with no index arithmetic.
// ---------------------------------------------------------------------------

import {
  TEMPLATE_BODY_MAX_CHARS,
  catalogEntryForName,
  templateBodyProblem,
} from "./template-catalog";

/** Languages Meta's review supports that this platform's merchants write in.
 *  The code is Meta's; a template exists once per (name, language). */
export const TEMPLATE_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "hi", label: "Hindi" },
  { code: "mr", label: "Marathi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "pa", label: "Punjabi" },
];

export const CUSTOM_TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING"] as const;
export type CustomTemplateCategory =
  (typeof CUSTOM_TEMPLATE_CATEGORIES)[number];

export const CUSTOM_TEMPLATE_LIMITS = {
  nameMaxChars: 512,
  headerMaxChars: 60,
  footerMaxChars: 60,
  bodyMaxChars: TEMPLATE_BODY_MAX_CHARS,
  maxButtons: 3,
  buttonTextMaxChars: 25,
  urlMaxChars: 2000,
  maxVariables: 10,
  variableNameMaxChars: 32,
  sampleMaxChars: 200,
} as const;

export const CUSTOM_BUTTON_TYPES = ["quick_reply", "url", "phone"] as const;
export type CustomButtonType = (typeof CUSTOM_BUTTON_TYPES)[number];

export const CUSTOM_BUTTON_LABELS: Record<CustomButtonType, string> = {
  quick_reply: "Quick reply",
  url: "Open a link",
  phone: "Call a number",
};

export type CustomTemplateButton =
  | { type: "quick_reply"; text: string }
  | { type: "url"; text: string; url: string }
  | { type: "phone"; text: string; phone: string };

export interface CustomTemplateVariable {
  /** The label the composer shows for this placeholder: a short slug. */
  name: string;
  /** The example Meta reviews the template with. */
  sample: string;
}

export interface CustomTemplateDraft {
  /** Meta's template name: lower-case letters, digits and underscores. */
  name: string;
  language: string;
  category: CustomTemplateCategory;
  headerText: string;
  body: string;
  variables: CustomTemplateVariable[];
  footerText: string;
  buttons: CustomTemplateButton[];
}

export type CustomTemplateCheck =
  | { ok: true; template: CustomTemplateDraft }
  | { ok: false; error: string };

/** Meta's rule for a name; StoreMink's own catalogue is `sm_…`. */
export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** A merchant's name for the template, as Meta spells it. */
export function templateNameFromTitle(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function oneLine(value: unknown): string {
  return text(value).replace(/\s+/g, " ");
}

/** The strict check a submit runs; the editor calls it too, before sending. */
export function validateCustomTemplate(input: unknown): CustomTemplateCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "The template is missing." };
  }
  const raw = input as Record<string, unknown>;
  const L = CUSTOM_TEMPLATE_LIMITS;

  const name = oneLine(raw.name);
  if (!name) return { ok: false, error: "Give the template a name." };
  if (!TEMPLATE_NAME.test(name)) {
    return {
      ok: false,
      error:
        "A template name uses lower-case letters, digits and underscores only, for example delivery_delay.",
    };
  }
  if (name.startsWith("sm_")) {
    return {
      ok: false,
      error: "Names starting with sm_ are StoreMink's own; choose another.",
    };
  }

  const language = oneLine(raw.language) || "en";
  if (!TEMPLATE_LANGUAGES.some((l) => l.code === language)) {
    return { ok: false, error: "Choose a language from the list." };
  }

  const category = oneLine(raw.category).toUpperCase();
  if (!(CUSTOM_TEMPLATE_CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      error: "Choose whether the template is utility or marketing.",
    };
  }

  const headerText = oneLine(raw.headerText);
  if (headerText.length > L.headerMaxChars) {
    return {
      ok: false,
      error: `The header can be at most ${L.headerMaxChars} characters.`,
    };
  }
  if (/\{\{|\}\}/.test(headerText)) {
    return {
      ok: false,
      error: "The header cannot contain a placeholder; put it in the message.",
    };
  }

  const footerText = oneLine(raw.footerText);
  if (footerText.length > L.footerMaxChars) {
    return {
      ok: false,
      error: `The footer can be at most ${L.footerMaxChars} characters.`,
    };
  }
  if (/\{\{|\}\}/.test(footerText)) {
    return {
      ok: false,
      error: "The footer cannot contain a placeholder; put it in the message.",
    };
  }

  const body = text(raw.body);
  const rawVariables = Array.isArray(raw.variables) ? raw.variables : [];
  if (rawVariables.length > L.maxVariables) {
    return {
      ok: false,
      error: `A template can have at most ${L.maxVariables} placeholders.`,
    };
  }
  const variables: CustomTemplateVariable[] = [];
  const seen = new Set<string>();
  for (const [i, v] of rawVariables.entries()) {
    const n = i + 1;
    const rec =
      v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const vname = oneLine(rec.name).toLowerCase().replace(/\s+/g, "_");
    if (!VARIABLE_NAME.test(vname)) {
      return {
        ok: false,
        error: `Give placeholder {{${n}}} a short label (letters, digits and underscores, starting with a letter).`,
      };
    }
    if (seen.has(vname)) {
      return {
        ok: false,
        error: `Two placeholders are both labelled "${vname}". Give each its own label.`,
      };
    }
    seen.add(vname);
    const sample = oneLine(rec.sample);
    if (!sample) {
      return {
        ok: false,
        error: `Give placeholder {{${n}}} a sample value for Meta's review.`,
      };
    }
    if (sample.length > L.sampleMaxChars) {
      return {
        ok: false,
        error: `A sample value can be at most ${L.sampleMaxChars} characters.`,
      };
    }
    variables.push({ name: vname, sample });
  }
  const bodyProblem = templateBodyProblem(
    body,
    variables.map((v) => v.sample),
  );
  if (bodyProblem) return { ok: false, error: bodyProblem };

  const rawButtons = Array.isArray(raw.buttons) ? raw.buttons : [];
  if (rawButtons.length > L.maxButtons) {
    return {
      ok: false,
      error: `A template can have at most ${L.maxButtons} buttons.`,
    };
  }
  const buttons: CustomTemplateButton[] = [];
  const labels = new Set<string>();
  let sawOther = false;
  for (const [i, b] of rawButtons.entries()) {
    const n = i + 1;
    const rec =
      b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    const type = oneLine(rec.type);
    const label = oneLine(rec.text);
    if (!(CUSTOM_BUTTON_TYPES as readonly string[]).includes(type)) {
      return { ok: false, error: `Choose what button ${n} does.` };
    }
    if (!label) return { ok: false, error: `Give button ${n} a label.` };
    if (label.length > L.buttonTextMaxChars) {
      return {
        ok: false,
        error: `Button labels can be at most ${L.buttonTextMaxChars} characters ("${label}" is too long).`,
      };
    }
    if (labels.has(label.toLowerCase())) {
      return {
        ok: false,
        error: `Two buttons are both called "${label}". Give each a different label.`,
      };
    }
    labels.add(label.toLowerCase());
    if (type === "quick_reply") {
      if (sawOther) {
        return {
          ok: false,
          error: "Put quick-reply buttons before link and call buttons.",
        };
      }
      buttons.push({ type: "quick_reply", text: label });
      continue;
    }
    sawOther = true;
    if (type === "url") {
      const url = oneLine(rec.url);
      if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > L.urlMaxChars) {
        return { ok: false, error: `Button ${n} needs a full https:// link.` };
      }
      if (/\{\{|\}\}/.test(url)) {
        return {
          ok: false,
          error: `Button ${n}'s link cannot contain a placeholder.`,
        };
      }
      buttons.push({ type: "url", text: label, url });
      continue;
    }
    const phone = oneLine(rec.phone).replace(/[\s()-]/g, "");
    if (!/^\+?[1-9]\d{6,14}$/.test(phone)) {
      return {
        ok: false,
        error: `Button ${n} needs a phone number with its country code, for example +91 98765 43210.`,
      };
    }
    buttons.push({
      type: "phone",
      text: label,
      phone: phone.startsWith("+") ? phone : `+${phone}`,
    });
  }

  return {
    ok: true,
    template: {
      name,
      language,
      category: category as CustomTemplateCategory,
      headerText,
      body,
      variables,
      footerText,
      buttons,
    },
  };
}

/** Meta's `components` array for a merchant's template: header, body with
 *  its examples, footer, buttons (quick replies first). */
export function customTemplateComponents(t: CustomTemplateDraft): unknown[] {
  const out: unknown[] = [];
  if (t.headerText) {
    out.push({ type: "HEADER", format: "TEXT", text: t.headerText });
  }
  const body: Record<string, unknown> = { type: "BODY", text: t.body };
  if (t.variables.length > 0) {
    body.example = { body_text: [t.variables.map((v) => v.sample)] };
  }
  out.push(body);
  if (t.footerText) out.push({ type: "FOOTER", text: t.footerText });
  if (t.buttons.length > 0) {
    out.push({
      type: "BUTTONS",
      buttons: t.buttons.map((b) =>
        b.type === "quick_reply"
          ? { type: "QUICK_REPLY", text: b.text }
          : b.type === "url"
            ? { type: "URL", text: b.text, url: b.url }
            : { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone },
      ),
    });
  }
  return out;
}

/** A button as the composer and the manager show it, read back off stored
 *  components (ours or Meta's listing). */
export interface TemplateButtonView {
  type: "quick_reply" | "url" | "phone" | "copy_code" | "other";
  text: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function templateButtonsOf(components: unknown): TemplateButtonView[] {
  if (!Array.isArray(components)) return [];
  const out: TemplateButtonView[] = [];
  for (const c of components) {
    if (!isRec(c) || c.type !== "BUTTONS" || !Array.isArray(c.buttons))
      continue;
    for (const b of c.buttons) {
      if (!isRec(b)) continue;
      const kind = String(b.type ?? "").toUpperCase();
      const label = typeof b.text === "string" ? b.text : "";
      out.push({
        type:
          kind === "QUICK_REPLY"
            ? "quick_reply"
            : kind === "URL"
              ? "url"
              : kind === "PHONE_NUMBER"
                ? "phone"
                : kind === "COPY_CODE"
                  ? "copy_code"
                  : "other",
        text: label,
      });
    }
  }
  return out;
}

/** The header's text, when the template has a text header. */
export function templateHeaderText(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const c of components) {
    if (isRec(c) && c.type === "HEADER") {
      return String(c.format ?? "").toUpperCase() === "TEXT" &&
        typeof c.text === "string"
        ? c.text
        : "";
    }
  }
  return "";
}

export function templateFooterText(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const c of components) {
    if (isRec(c) && c.type === "FOOTER" && typeof c.text === "string") {
      return c.text;
    }
  }
  return "";
}

/**
 * ★ Can the inbox composer send this template with the body's values alone?
 * False for anything that needs a value at send time: a header that is not
 * plain text (a picture, a variable), a link button carrying a placeholder, a
 * copy-code button, or any button kind we do not know. Quick replies are
 * fine: their payload is their label (quickReplyPayloadsFor).
 */
export function templateNeedsSendParameters(components: unknown): boolean {
  if (!Array.isArray(components)) return false;
  for (const c of components) {
    if (!isRec(c)) continue;
    if (c.type === "HEADER") {
      const format = String(c.format ?? "").toUpperCase();
      if (format !== "TEXT") return true;
      if (typeof c.text !== "string" || /\{\{|\}\}/.test(c.text)) return true;
    }
    if (c.type === "BUTTONS" && Array.isArray(c.buttons)) {
      for (const b of c.buttons) {
        if (!isRec(b)) return true;
        const kind = String(b.type ?? "").toUpperCase();
        if (kind === "QUICK_REPLY" || kind === "PHONE_NUMBER") continue;
        if (kind === "URL") {
          if (typeof b.url !== "string" || /\{\{|\}\}/.test(b.url)) return true;
          continue;
        }
        return true;
      }
    }
    if (c.type === "CAROUSEL" || c.type === "LIMITED_TIME_OFFER") return true;
  }
  return false;
}

/** The payload a hand-sent quick reply carries: its own label, prefixed so
 *  nothing downstream (the COD and menu parsers) can mistake it for theirs.
 *  The tap comes back as an ordinary customer message with that label. */
export function quickReplyPayloadsFor(components: unknown): string[] {
  return templateButtonsOf(components)
    .filter((b) => b.type === "quick_reply")
    .map((b) => `custom:${b.text}`.slice(0, 256));
}

/**
 * ★ WHICH TEMPLATES A PERSON MAY SEND BY HAND FROM THE INBOX. One of
 * StoreMink's own with buttons never: its buttons carry payloads only the
 * order flow writes (a COD Confirm sent by hand would come back as two words
 * nobody can act on). A merchant's own template may carry quick replies
 * (their tap comes back as the label, which is an answer) and static link or
 * call buttons; only one needing a value at send time is withheld, because
 * the composer has no field for it. Shared by the picker and the send
 * action, which is the boundary.
 */
export function composerCanSend(row: {
  name: string;
  eventKey?: string | null;
  components: unknown;
}): boolean {
  const catalogue =
    (row.eventKey ?? null) !== null || Boolean(catalogEntryForName(row.name));
  if (catalogue) {
    return !(
      Array.isArray(row.components) &&
      row.components.some((c) => isRec(c) && c.type === "BUTTONS")
    );
  }
  return !templateNeedsSendParameters(row.components);
}
