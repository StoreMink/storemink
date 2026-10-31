import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, posix } from "path";

// ---------------------------------------------------------------------------
// iPhone input zoom (Theme Studio TS-3E, 25 Oct 2026; owner-approved 24 Oct).
//
// ★★ iOS Safari ZOOMS THE WHOLE PAGE when a shopper taps a text box whose
// text is under 16px, and it does not zoom back out: the shopper is left on a
// magnified, sideways-scrolling page. Every iPhone browser is Safari
// underneath (Chrome and the Instagram and WhatsApp in-app browsers too), and
// Chrome's phone emulation never shows it, so Theme Studio's browser check
// cannot see it either.
//
// The fix is CSS, at phone widths only: `@media (max-width: 600px)` sets the
// box's text to 16px (the profile page's and the shop sort's pattern); larger
// screens keep their size. Turning zoom off instead (maximum-scale,
// user-scalable=no) is never the fix: people must still be able to zoom.
//
// This file reads the stylesheets and the markup as text (no browser) and
// pins:
//   1. the six boxes fixed on 25 Oct 2026 keep a 16px phone rule;
//   2. no stylesheet a storefront page loads (app/(storefront), components/,
//      app/globals.css) gives an input, select or textarea, or its
//      placeholder, text under 16px at a phone width, except ALLOW_LIST,
//      where every entry says why;
//   3. no text box a storefront page renders sets text under 16px in its own
//      markup (an inline fontSize or a Tailwind text class), except
//      MARKUP_ALLOW_LIST;
//   4. nothing turns zoom off.
// A text box is found three ways: an `input` (not a checkbox, radio, range,
// ...), `select` or `textarea` element in the selector; a class the markup
// puts on such an element (`styles.x` or a `className` string); or a class
// whose last word is input, select or textarea (classes passed through props,
// such as the footer's newsletter box). A phone rule counts only when it uses
// the SAME selector and comes after the base rule (or is !important): a
// different selector is a different specificity, and an earlier one loses on
// source order.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

/** Repo-relative paths (forward slashes) under `dir` whose name passes `keep`. */
function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...walk(path, keep));
    } else if (keep(entry.name)) out.push(path);
  }
  return out.sort();
}

const isCss = (name: string) => name.endsWith(".css");
const isSource = (name: string) =>
  /\.(tsx|ts|jsx|js)$/.test(name) && !/\.test\./.test(name);

/** Every stylesheet a storefront page can load. */
const STYLESHEETS = [
  ...walk("app/(storefront)", isCss),
  ...walk("components", isCss),
  "app/globals.css",
];
/** The markup that renders the storefront's text boxes (and, in
 *  components/, the dashboard's: more markup only finds more boxes). */
const MARKUP = [
  ...walk("app/(storefront)", isSource),
  ...walk("components", isSource),
];

/** The markup a storefront page renders: app/(storefront) and every
 *  components/ file it imports, directly or through another. */
function storefrontMarkup(): string[] {
  const own = walk("app/(storefront)", isSource);
  const seen = new Set(own);
  const queue = [...own];
  const isFile = (path: string) =>
    existsSync(join(REPO, path)) && statSync(join(REPO, path)).isFile();
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const m of read(file).matchAll(
      /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g,
    )) {
      const spec = m[1] ?? m[2];
      const base = spec.startsWith("@/")
        ? spec.slice(2)
        : spec.startsWith(".")
          ? posix.normalize(posix.join(posix.dirname(file), spec))
          : "";
      if (!base.startsWith("components/")) continue;
      const hit = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]
        .map((ending) => base + ending)
        .find((path) => isSource(path) && isFile(path));
      if (hit && !seen.has(hit)) {
        seen.add(hit);
        queue.push(hit);
      }
    }
  }
  return Array.from(seen).sort();
}

// ---- devices ---------------------------------------------------------------

type Device = { width: number; touch: boolean };
/** Portrait phone widths, the 320px iPhone SE up to the 430px Pro Max. */
const PHONES: Device[] = [320, 360, 375, 390, 414, 430].map((width) => ({
  width,
  touch: true,
}));
const DESKTOP: Device = { width: 1280, touch: false };
/** iOS zooms when the focused box's text is UNDER this. */
const IOS_MIN_PX = 16;
type Maybe = boolean | "unknown";

// ---- a small CSS reader ----------------------------------------------------

type Decl = { prop: string; value: string; important: boolean };
type Rule = {
  selectors: string[];
  decls: Decl[];
  atRules: string[];
  order: number;
};

/** Index of the quote closing the string that opens at `i`. */
function quotedEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== text[i]) j += text[j] === "\\" ? 2 : 1;
  return j;
}

function stripComments(css: string): string {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      out += " ";
    } else if (css[i] === '"' || css[i] === "'") {
      const end = quotedEnd(css, i);
      out += css.slice(i, end + 1);
      i = end;
    } else out += css[i];
  }
  return out;
}

/** Splits at `separator` outside (), [] and strings. */
function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = quotedEnd(text, i);
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && separator.test(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One spelling per selector: single spaces, spaced combinators. */
function normalizeSelector(selector: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '"' || c === "'") {
      const end = quotedEnd(selector, i);
      out += selector.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (depth === 0 && (c === ">" || c === "+" || c === "~")) {
      out = `${out.trimEnd()} ${c} `;
      while (/\s/.test(selector[i + 1] ?? "")) i++;
    } else if (/\s/.test(c)) {
      if (!out.endsWith(" ")) out += " ";
    } else out += c;
  }
  return out.trim();
}

function parseDecl(text: string): Decl[] {
  const colon = text.indexOf(":");
  if (colon < 1) return [];
  let value = text.slice(colon + 1).trim();
  const important = /!\s*important$/i.test(value);
  if (important) value = value.replace(/!\s*important$/i, "").trim();
  return [
    { prop: text.slice(0, colon).trim().toLowerCase(), value, important },
  ];
}

/** Style rules in source order, each with the at-rules around it. */
function parseCss(css: string): Rule[] {
  const src = stripComments(css);
  const rules: Rule[] = [];
  const stack: { prelude: string; decls: string[] }[] = [];
  let buffer = "";
  let parens = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = quotedEnd(src, i);
      buffer += src.slice(i, end + 1);
      i = end;
    } else if (c === "(" || (c === ")" && parens > 0)) {
      parens += c === "(" ? 1 : -1;
      buffer += c;
    } else if (parens > 0) buffer += c;
    else if (c === "{") {
      stack.push({ prelude: buffer.trim(), decls: [] });
      buffer = "";
    } else if (c === ";") {
      stack[stack.length - 1]?.decls.push(buffer.trim());
      buffer = "";
    } else if (c === "}") {
      const block = stack.pop();
      if (block && buffer.trim()) block.decls.push(buffer.trim());
      if (block && !block.prelude.startsWith("@")) {
        rules.push({
          selectors: splitTop(block.prelude, /,/).map(normalizeSelector),
          decls: block.decls.flatMap(parseDecl),
          atRules: stack.map((b) => b.prelude).filter((p) => p.startsWith("@")),
          order: rules.length,
        });
      }
      buffer = "";
    } else buffer += c;
  }
  // Keyframe steps and font faces style no element.
  return rules.filter(
    (rule) =>
      !rule.atRules.some((at) =>
        /^@(-webkit-)?(keyframes|font-face|page)/i.test(at),
      ),
  );
}

// ---- media queries -----------------------------------------------------------

/** A media-query length in px (em and rem are 16px there). */
function mediaLengthPx(value: string): number | null {
  const m = /^(\d*\.?\d+)(px|em|rem)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === "px" ? 1 : 16);
}

function compareWidth(width: number, op: string, px: number): boolean {
  if (op === "<=") return width <= px;
  if (op === "<") return width < px;
  if (op === ">=") return width >= px;
  return width > px;
}

const FLIP: Record<string, string> = {
  "<=": ">=",
  "<": ">",
  ">=": "<=",
  ">": "<",
};

function mediaFeature(feature: string, device: Device): Maybe {
  const f = feature.trim();
  if (f === "all" || f === "screen") return true;
  if (f === "print" || f === "speech") return false;
  const plain = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/.exec(f);
  if (plain) {
    const [, name, value] = plain;
    if (name === "max-width" || name === "min-width") {
      const px = mediaLengthPx(value);
      if (px === null) return "unknown";
      return name === "max-width" ? device.width <= px : device.width >= px;
    }
    // A phone has no hover and a coarse pointer; a desktop the opposite.
    if (name === "hover" || name === "any-hover")
      return value === (device.touch ? "none" : "hover");
    if (name === "pointer" || name === "any-pointer")
      return value === (device.touch ? "coarse" : "fine");
    return "unknown";
  }
  // Range syntax: (width <= 600px), (600px >= width), (320px <= width < 600px).
  const range =
    /^\(\s*(?:(\S+)\s*(<=|<|>=|>)\s*)?width\s*(?:(<=|<|>=|>)\s*(\S+))?\s*\)$/.exec(
      f,
    );
  if (range && (range[1] || range[4])) {
    const checks: boolean[] = [];
    if (range[1]) {
      const px = mediaLengthPx(range[1]);
      if (px === null) return "unknown";
      checks.push(compareWidth(device.width, FLIP[range[2]], px));
    }
    if (range[4]) {
      const px = mediaLengthPx(range[4]);
      if (px === null) return "unknown";
      checks.push(compareWidth(device.width, range[3], px));
    }
    return checks.every(Boolean);
  }
  return "unknown";
}

function mediaQuery(query: string, device: Device): Maybe {
  let q = query.trim().toLowerCase();
  const negate = q.startsWith("not ");
  if (negate) q = q.slice(4);
  else if (q.startsWith("only ")) q = q.slice(5);
  let result: Maybe = true;
  for (const part of q.split(/\s+and\s+/)) {
    const r = mediaFeature(part, device);
    if (r === false) {
      result = false;
      break;
    }
    if (r === "unknown") result = "unknown";
  }
  if (negate && result !== "unknown") return !result;
  return result;
}

/** Whether one at-rule's condition holds on `device`. */
function atRuleHolds(prelude: string, device: Device): Maybe {
  const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude);
  const name = m?.[1].toLowerCase();
  if (name === "layer") return true;
  if (name !== "media" || !m) return "unknown"; // @supports, @container, ...
  let sawUnknown = false;
  for (const query of splitTop(m[2], /,/)) {
    const r = mediaQuery(query, device);
    if (r === true) return true;
    if (r === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : false;
}

function applies(rule: Rule, device: Device): Maybe {
  let result: Maybe = true;
  for (const at of rule.atRules) {
    const r = atRuleHolds(at, device);
    if (r === false) return false;
    if (r === "unknown") result = "unknown";
  }
  return result;
}

// ---- font sizes --------------------------------------------------------------

const KEYWORD_PX: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

type Quantity = { value: number; length: boolean };

/** A length expression in px on `device`, or null when it cannot be known
 *  from the stylesheet alone (an unset var(), vh, inherit, ...). 1rem and
 *  1em are 16px: nothing in scope resizes the root (pinned below), and an em
 *  box is assumed to sit in 16px text. */
function lengthPx(expression: string, device: Device): number | null {
  // Custom properties first, or `--x` would read as two minus signs.
  const tokens =
    expression
      .toLowerCase()
      .match(
        /--[\w-]+|-?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?(?:[a-z%]+)?|[a-z-]+\(|[()+*/,-]/g,
      ) ?? [];
  if (tokens.join("") !== expression.toLowerCase().replace(/\s+/g, ""))
    return null; // something this reader does not understand
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];

  function unit(token: string): Quantity | null {
    const m = /^(-?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)([a-z%]*)$/.exec(token);
    if (!m) return null;
    const n = Number(m[1]);
    const scale: Record<string, number> = {
      px: 1,
      rem: 16,
      em: 16,
      "%": 0.16,
      pt: 4 / 3,
      vw: device.width / 100,
      svw: device.width / 100,
      lvw: device.width / 100,
      dvw: device.width / 100,
    };
    if (m[2] === "") return { value: n, length: false };
    return m[2] in scale ? { value: n * scale[m[2]], length: true } : null;
  }

  function args(): (Quantity | null)[] {
    const list: (Quantity | null)[] = [sum()];
    while (peek() === ",") {
      next();
      list.push(sum());
    }
    if (next() !== ")") return [null];
    return list;
  }

  function primary(): Quantity | null {
    const token = next();
    if (token === undefined) return null;
    if (token === "(") {
      const inner = sum();
      return next() === ")" ? inner : null;
    }
    if (token === "-") {
      const inner = primary();
      return inner && { ...inner, value: -inner.value };
    }
    if (token === "var(") {
      next(); // the custom property: its value is not known here
      if (peek() !== ",") {
        next();
        return null;
      }
      next();
      const fallback = sum();
      return next() === ")" ? fallback : null;
    }
    if (token === "calc(") {
      const inner = sum();
      return next() === ")" ? inner : null;
    }
    if (token === "min(" || token === "max(" || token === "clamp(") {
      const values = args();
      if (values.some((v) => v === null || !v.length)) return null;
      const n = (values as Quantity[]).map((v) => v.value);
      if (token === "min(") return { value: Math.min(...n), length: true };
      if (token === "max(") return { value: Math.max(...n), length: true };
      if (n.length !== 3) return null;
      return { value: Math.max(n[0], Math.min(n[1], n[2])), length: true };
    }
    return unit(token);
  }

  function product(): Quantity | null {
    let left = primary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const right = primary();
      if (!left || !right) return null;
      if (op === "*") {
        if (left.length && right.length) return null;
        left = {
          value: left.value * right.value,
          length: left.length || right.length,
        };
      } else {
        if (right.length || right.value === 0) return null;
        left = { value: left.value / right.value, length: left.length };
      }
    }
    return left;
  }

  function sum(): Quantity | null {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = product();
      if (!left || !right || left.length !== right.length) return null;
      left = {
        value: left.value + (op === "+" ? right.value : -right.value),
        length: left.length,
      };
    }
    return left;
  }

  const result = sum();
  if (at !== tokens.length || !result || !result.length) return null;
  return result.value;
}

const CSS_WIDE =
  /^(inherit|initial|unset|revert|revert-layer|smaller|larger)$/i;
const FONT_PREFIX =
  /^(normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|(ultra-|extra-|semi-)?(condensed|expanded))$/i;

function sizePx(value: string, device: Device): number | null {
  const v = value.trim().toLowerCase();
  if (v in KEYWORD_PX) return KEYWORD_PX[v];
  if (CSS_WIDE.test(v)) return null;
  return lengthPx(v, device);
}

/** The size inside a `font` shorthand: the first word after the style,
 *  weight and stretch keywords (`600 14px/1.3 Inter` is 14px). `font:
 *  inherit` or a system font sets no size this reader can see. */
function shorthandPx(value: string, device: Device): number | null {
  for (const word of splitTop(value, /\s/)) {
    if (FONT_PREFIX.test(word)) continue;
    return sizePx(splitTop(word, /\//)[0] ?? "", device);
  }
  return null;
}

/** The rule's winning `font-size` or `font` declaration, if any. */
function fontDecl(rule: Rule): Decl | null {
  let best: Decl | null = null;
  for (const decl of rule.decls) {
    if (decl.prop !== "font-size" && decl.prop !== "font") continue;
    if (!best || decl.important || !best.important) best = decl;
  }
  return best;
}

function declPx(decl: Decl, device: Device): number | null {
  return decl.prop === "font"
    ? shorthandPx(decl.value, device)
    : sizePx(decl.value, device);
}

type Size = { px: number; value: string };

/** The font size `selector` ends up with on `device`, from the rules that
 *  name exactly that selector: !important first, then unlayered before
 *  @layer, then the later rule. A rule whose condition this reader cannot
 *  settle (@supports, @container, prefers-*) can only make it smaller. */
function sizeAt(rules: Rule[], selector: string, device: Device): Size | null {
  const candidates = rules
    .map((rule) => ({
      rule,
      decl: fontDecl(rule),
      holds: applies(rule, device),
    }))
    .filter(
      (c): c is { rule: Rule; decl: Decl; holds: Maybe } =>
        c.rule.selectors.includes(selector) &&
        c.decl !== null &&
        c.holds !== false,
    )
    .sort((a, b) => {
      if (a.decl.important !== b.decl.important)
        return a.decl.important ? -1 : 1;
      const layered = (r: Rule) => r.atRules.some((at) => /^@layer/i.test(at));
      if (layered(a.rule) !== layered(b.rule)) return layered(a.rule) ? 1 : -1;
      return b.rule.order - a.rule.order;
    });
  for (const c of candidates) {
    const px = declPx(c.decl, device);
    if (c.holds === true)
      return px === null ? null : { px, value: c.decl.value };
    if (px !== null && px < IOS_MIN_PX) return { px, value: c.decl.value };
  }
  return null;
}

// ---- which selectors style a text box ----------------------------------------

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
]);

/** Removes `:global(` / `:local(` wrappers, keeping what they wrap. */
function unwrapModuleScopes(compound: string): string {
  let out = compound;
  for (;;) {
    const m = /:(global|local)\(/.exec(out);
    if (!m) return out;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === "(") depth++;
      if (out[i] === ")") depth--;
    }
    out =
      out.slice(0, m.index) +
      out.slice(m.index + m[0].length, i - 1) +
      out.slice(i);
  }
}

/** Removes functional pseudo-classes (`:not(...)`, `:has(...)`): what they
 *  name is not the element itself. */
function withoutFunctionalPseudos(compound: string): string {
  let out = compound;
  for (;;) {
    const m = /:[\w-]+\(/.exec(out);
    if (!m) return out;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === "(") depth++;
      if (out[i] === ")") depth--;
    }
    out = out.slice(0, m.index) + out.slice(i);
  }
}

/** A class whose last word is input, select or textarea (`searchInput`,
 *  `blog-search-input`, `.select`), but not `inputGroup` or `selected`. */
function looksLikeTextBox(className: string): boolean {
  const words = className
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  return /^(input|select|textarea)$/i.test(words[words.length - 1] ?? "");
}

/** Whether the element a selector styles is a text box (or its placeholder). */
function stylesTextBox(selector: string, markupClasses: Set<string>): boolean {
  const compounds = splitTop(selector, /\s/).filter((c) => !/^[>+~]$/.test(c));
  const subject = withoutFunctionalPseudos(
    unwrapModuleScopes(compounds[compounds.length - 1] ?? ""),
  );
  // A pseudo-element is another box, except the placeholder's text.
  const pseudoElement =
    /::([\w-]+)/.exec(subject)?.[1] ??
    /:(before|after|first-line|first-letter|-ms-input-placeholder|-moz-placeholder)\b/.exec(
      subject,
    )?.[1];
  if (pseudoElement && !/placeholder/.test(pseudoElement)) return false;
  const type = /^([a-z][\w-]*|\*)/i.exec(subject)?.[1].toLowerCase();
  if (type === "input") {
    const typeAttr =
      /\[\s*type\s*[~|^$*]?=\s*["']?([\w-]+)["']?\s*(?:i\s*)?\]/i.exec(subject);
    return !(typeAttr && NON_TEXT_INPUTS.has(typeAttr[1].toLowerCase()));
  }
  if (type === "select" || type === "textarea") return true;
  if (type && type !== "*") return false;
  const classes = Array.from(subject.matchAll(/\.([\w-]+)/g), (m) => m[1]);
  return classes.some((c) => markupClasses.has(c) || looksLikeTextBox(c));
}

// ---- the markup ----------------------------------------------------------------

type Markup = {
  /** CSS module path -> classes the markup puts on a text box. */
  moduleBoxes: Map<string, Set<string>>;
  /** CSS module path -> every class any importer references. */
  moduleRefs: Map<string, Set<string>>;
  /** Global class names the markup puts on a text box. */
  globalBoxes: Set<string>;
};

function setOf<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

/** Every JSX opening tag of `name` in `src`. */
function tagsIn(src: string, name: string): string[] {
  return Array.from(src.matchAll(new RegExp(`<${name}\\b`, "g")), (m) =>
    openingTag(src, m.index ?? 0),
  );
}

/** Whether a `<tag>` whose opening tag includes `marker` holds `child`
 *  before its `</tag>`, however the opening tag is spread over lines. */
function inside(
  src: string,
  tag: string,
  marker: string,
  child: string,
): boolean {
  for (const m of src.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
    const start = m.index ?? 0;
    const open = openingTag(src, start);
    if (!open.includes(marker)) continue;
    const end = src.indexOf(`</${tag}>`, start);
    const at = src.indexOf(child, start + open.length);
    if (at !== -1 && (end === -1 || at < end)) return true;
  }
  return false;
}

/** The JSX opening tag that starts at `start` (`<input ... >`). */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") i = quotedEnd(src, i);
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** The value after `className=` or `className:` at `i`. */
function attributeValue(tag: string, i: number): string {
  if (tag[i] === '"' || tag[i] === "'" || tag[i] === "`")
    return tag.slice(i, quotedEnd(tag, i) + 1);
  let depth = 0;
  for (let j = i; j < tag.length; j++) {
    const c = tag[j];
    if (c === '"' || c === "'" || c === "`") j = quotedEnd(tag, j);
    else if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") {
      if (depth === 0) return tag.slice(i, j);
      depth--;
      if (depth === 0 && tag[i] === "{") return tag.slice(i, j + 1);
    } else if (depth === 0 && (c === "," || /\s/.test(c)))
      return tag.slice(i, j);
  }
  return tag.slice(i);
}

/** Class names written as strings in a className value. */
function stringClasses(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    const text = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    out.push(...text.split(/\s+/).filter((t) => /^-?[_a-zA-Z][\w-]*$/.test(t)));
  }
  return out;
}

/** An `<input>` tag's type, lower case ("" when it sets none). */
function inputType(tag: string): string {
  const type =
    /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/.exec(
      tag,
    );
  return (type?.[1] ?? type?.[2] ?? type?.[3] ?? "").toLowerCase();
}

/** Tailwind's text sizes under 16px. */
const TAILWIND_SMALL_TEXT = new Map([
  ["text-xs", 12],
  ["text-sm", 14],
]);

/** The phone-width font size a text box's own markup sets: an inline
 *  `fontSize` (a bare number is px) or an unprefixed Tailwind text class
 *  (`text-sm`, `text-[15px]`; `md:text-sm` is for larger screens). Null when
 *  it sets none this reader can size. A stylesheet cannot give these a phone
 *  rule, so they are checked apart from the stylesheets. */
function markupFontPx(tag: string): number | null {
  const inline = /\bfontSize\s*:\s*(?:(\d*\.?\d+)\b|["'`]([^"'`]+)["'`])/.exec(
    tag,
  );
  if (inline)
    return inline[1] !== undefined
      ? Number(inline[1])
      : sizePx(inline[2], PHONES[0]);
  for (const a of tag.matchAll(/\bclassName\s*=\s*/g)) {
    const value = attributeValue(tag, (a.index ?? 0) + a[0].length);
    for (const m of value.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      for (const token of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)) {
        const small = TAILWIND_SMALL_TEXT.get(token);
        if (small !== undefined) return small;
        const arbitrary = /^text-\[(.+)\]$/.exec(token);
        const px = arbitrary ? sizePx(arbitrary[1], PHONES[0]) : null;
        if (px !== null) return px;
      }
    }
  }
  return null;
}

/** Text boxes in `files` whose own markup sets text under 16px, sorted; one
 *  MARKUP_ALLOW_LIST explains reads "<file>  <its marker>". */
function markupFindings(
  files: string[],
  readFile: (path: string) => string = read,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    const src = readFile(file);
    for (const name of ["input", "select", "textarea"]) {
      for (const tag of tagsIn(src, name)) {
        if (name === "input" && NON_TEXT_INPUTS.has(inputType(tag))) continue;
        const px = markupFontPx(tag);
        if (px === null || px >= IOS_MIN_PX) continue;
        const entry = MARKUP_ALLOW_LIST.find(
          (a) => a.file === file && tag.includes(a.marker),
        );
        found.push(
          entry
            ? `${file}  ${entry.marker}`
            : `${file}: ${px}px in ${tag.replace(/\s+/g, " ").slice(0, 90)}`,
        );
      }
    }
  }
  return found.sort();
}

function scanMarkup(
  files: string[],
  readFile: (path: string) => string = read,
): Markup {
  const markup: Markup = {
    moduleBoxes: new Map(),
    moduleRefs: new Map(),
    globalBoxes: new Set(),
  };
  for (const file of files) {
    const src = readFile(file);
    const modules = new Map<string, string>();
    for (const m of src.matchAll(
      /import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g,
    )) {
      modules.set(
        m[1],
        m[2].startsWith("@/")
          ? m[2].slice(2)
          : posix.normalize(posix.join(posix.dirname(file), m[2])),
      );
    }
    const refsIn = (text: string, binding: string) =>
      Array.from(
        text.matchAll(
          new RegExp(
            `\\b${binding}(?:\\.([A-Za-z_$][\\w$]*)|\\[\\s*["']([^"']+)["']\\s*\\])`,
            "g",
          ),
        ),
        (m) => m[1] ?? m[2],
      );
    for (const [binding, css] of modules) {
      for (const ref of refsIn(src, binding))
        setOf(markup.moduleRefs, css).add(ref);
    }
    for (const m of src.matchAll(/<(input|select|textarea|PhoneInput)\b/g)) {
      const tag = openingTag(src, m.index ?? 0);
      if (m[1] === "input") {
        const value = inputType(tag);
        if (NON_TEXT_INPUTS.has(value)) continue;
      }
      for (const [binding, css] of modules) {
        for (const ref of refsIn(tag, binding))
          setOf(markup.moduleBoxes, css).add(ref);
      }
      // PhoneInput's own className is its wrapper; numberInputProps'
      // `className:` is the box.
      const attribute =
        m[1] === "PhoneInput"
          ? /\bclassName\s*:\s*/g
          : /\bclassName\s*[=:]\s*/g;
      for (const a of tag.matchAll(attribute)) {
        const value = attributeValue(tag, (a.index ?? 0) + a[0].length);
        for (const c of stringClasses(value)) markup.globalBoxes.add(c);
      }
    }
  }
  return markup;
}

// ---- the scan --------------------------------------------------------------------

type Finding = {
  file: string;
  selector: string;
  width: number;
  value: string;
  px: number;
};

function scanSheet(file: string, css: string, markup: Markup) {
  const rules = parseCss(css);
  const classes = new Set([
    ...markup.globalBoxes,
    ...(markup.moduleBoxes.get(file) ?? []),
  ]);
  const boxSelectors = Array.from(
    new Set(rules.flatMap((r) => r.selectors)),
  ).filter((s) => stylesTextBox(s, classes));
  const findings: Finding[] = [];
  for (const selector of boxSelectors) {
    for (const phone of PHONES) {
      const size = sizeAt(rules, selector, phone);
      if (size && size.px < IOS_MIN_PX) {
        findings.push({
          file,
          selector,
          width: phone.width,
          value: size.value,
          px: Math.round(size.px * 100) / 100,
        });
        break;
      }
    }
  }
  return { rules, boxSelectors, findings };
}

const EMPTY_MARKUP: Markup = {
  moduleBoxes: new Map(),
  moduleRefs: new Map(),
  globalBoxes: new Set(),
};
const findingsIn = (css: string) =>
  scanSheet("x.css", css, EMPTY_MARKUP).findings;

// ---- the six boxes and the allow-list ------------------------------------------

/** The six boxes the 24 Oct research found under 16px on phones, fixed on
 *  25 Oct 2026. `shows` proves the markup still renders the box the
 *  selector styles, so this never guards a dead rule. */
const BOXES: {
  box: string;
  css: string;
  selector: string;
  markup: string;
  shows: (src: string) => boolean;
}[] = [
  {
    box: "product page PIN code",
    css: "app/(storefront)/(pages)/shop/shop.css",
    selector: ".pdp-delivery-form input",
    markup:
      "app/(storefront)/components/delivery/product-delivery-estimator.tsx",
    shows: (src) =>
      inside(src, "form", 'className="pdp-delivery-form"', "<input"),
  },
  {
    box: "coupon",
    css: "app/(storefront)/components/cart/CouponField.module.css",
    selector: ".input",
    markup: "app/(storefront)/components/cart/CouponField.tsx",
    shows: (src) =>
      tagsIn(src, "input").some((t) => t.includes("className={styles.input}")),
  },
  {
    box: "delivery location PIN code",
    css: "app/(storefront)/components/delivery/delivery-location.module.css",
    selector: ".form input",
    markup:
      "app/(storefront)/components/delivery/delivery-location-control.tsx",
    shows: (src) => inside(src, "form", "className={styles.form}", "<input"),
  },
  {
    box: "checkout contact and address",
    css: "app/(storefront)/(pages)/checkout/checkout.module.css",
    selector: ".input",
    markup: "app/(storefront)/(pages)/checkout/page.tsx",
    shows: (src) =>
      tagsIn(src, "input").some((t) => t.includes("className={styles.input}")),
  },
  {
    box: "checkout pickup store search",
    css: "app/(storefront)/(pages)/checkout/checkout.module.css",
    selector: ".pickerInput",
    markup: "app/(storefront)/(pages)/checkout/page.tsx",
    shows: (src) =>
      tagsIn(src, "input").some((t) =>
        t.includes("className={styles.pickerInput}"),
      ),
  },
  {
    box: "enquiry name, email, own subject and message",
    css: "app/(storefront)/(pages)/enquiries/enquiries.module.css",
    selector: ".input",
    markup: "app/(storefront)/(pages)/enquiries/enquiries-form.tsx",
    shows: (src) =>
      tagsIn(src, "input").some((t) =>
        t.includes("className={styles.input}"),
      ) && tagsIn(src, "textarea").some((t) => t.includes("${styles.input}")),
  },
  {
    box: "enquiry phone",
    css: "app/(storefront)/(pages)/enquiries/enquiries.module.css",
    selector: ".phoneInput",
    markup: "app/(storefront)/(pages)/enquiries/enquiries-form.tsx",
    shows: (src) =>
      tagsIn(src, "PhoneInput").some((t) =>
        t.includes("className: styles.phoneInput"),
      ),
  },
  {
    box: "enquiry subject",
    css: "app/(storefront)/(pages)/enquiries/enquiries.module.css",
    selector: ".select",
    markup: "app/(storefront)/(pages)/enquiries/enquiries-form.tsx",
    shows: (src) =>
      tagsIn(src, "select").some((t) =>
        t.includes("className={styles.select}"),
      ),
  },
  {
    box: "not-found page search",
    css: "app/(storefront)/not-found.css",
    selector: ".sf404-search input",
    markup: "app/(storefront)/not-found.tsx",
    shows: (src) => inside(src, "form", 'className="sf404-search"', "<input"),
  },
];

type Allowed = {
  file: string;
  selector: string;
  /** unused: no markup uses the class (checked below). hidden: never shown
   *  on a phone (checked below). zooms: a real box that still zooms an
   *  iPhone, not among the six above; fix it with the same rule and delete
   *  its entry (the stale check below insists). */
  kind: "unused" | "hidden" | "zooms";
  reason: string;
};

const ALLOW_LIST: Allowed[] = [
  {
    file: "app/(storefront)/components/header/Header.module.css",
    selector: ".searchInput",
    kind: "hidden",
    reason:
      "The header's own search box is display:none at 768px and below; phones search in the sheet, whose box (.searchWrapSheet .searchInput) is 16px.",
  },
  {
    file: "app/(storefront)/components/auth/AuthModal.module.css",
    selector: ".countrySelect",
    kind: "unused",
    reason:
      "No markup uses it: the sign-in phone row renders components/ui/phone-country-select.tsx, whose invisible select inherits the page's 16px.",
  },
  {
    file: "app/(storefront)/(pages)/enquiries/enquiries.module.css",
    selector: ".countrySelect",
    kind: "unused",
    reason:
      "No markup uses it: the enquiry phone row renders components/ui/phone-country-select.tsx, whose invisible select inherits the page's 16px.",
  },
  // ★ STILL ZOOMS AN IPHONE. The 24 Oct research named six boxes and the
  // owner approved those; this scan found the boxes below too. Each needs
  // only its 16px phone rule, with the owner's or the main session's OK
  // (TS-3E report, "open"). Delete the entry with the fix; never add one.
  {
    file: "app/(storefront)/(pages)/blogs/blogs.css",
    selector: ".blog-search-input",
    kind: "zooms",
    reason: "The blog list's search box, 0.95rem.",
  },
  {
    file: "app/(storefront)/(pages)/blogs/write/write-blog.css",
    selector: ".write-blog-textarea",
    kind: "zooms",
    reason: "The Excerpt box in the Write a blog editor, 0.95rem.",
  },
  {
    file: "app/(storefront)/(pages)/orders/orders.module.css",
    selector: ".returnQty",
    kind: "zooms",
    reason: "The return request's quantity select on an order page, 0.85rem.",
  },
  {
    file: "app/(storefront)/(pages)/orders/orders.module.css",
    selector: ".returnSwap",
    kind: "zooms",
    reason: "The return request's exchange size or colour select, 0.82rem.",
  },
  {
    file: "app/(storefront)/(pages)/orders/orders.module.css",
    selector: ".returnField select",
    kind: "zooms",
    reason: "The return request's reason select, 0.9rem.",
  },
  {
    file: "app/(storefront)/(pages)/orders/orders.module.css",
    selector: ".returnField textarea",
    kind: "zooms",
    reason: "The return request's details box, 0.9rem.",
  },
  {
    file: "app/(storefront)/(pages)/orders/orders.module.css",
    selector: ".cancelReasonInput",
    kind: "zooms",
    reason: "The cancel order reason box on an order page, 0.85rem.",
  },
  {
    file: "app/(storefront)/(pages)/shop/shop.css",
    selector: ".pdp-review-textarea",
    kind: "zooms",
    reason: "The product page's write-a-review box, 0.92rem.",
  },
  {
    file: "app/(storefront)/components/auth/AuthModal.module.css",
    selector: ".textInput",
    kind: "zooms",
    reason:
      "The sign-in dialog's first name, last name and email boxes for a new account, 15px.",
  },
  {
    file: "app/(storefront)/components/footer/Footer.module.css",
    selector: ".newsletterInput",
    kind: "zooms",
    reason:
      "The footer's newsletter email box, on every page of a store that turns the footer newsletter on, 14px.",
  },
  {
    file: "app/(storefront)/storefront-theme.css",
    selector: ".blog-comment-textarea",
    kind: "zooms",
    reason: "The comment box under a blog post, 15px.",
  },
];

/** Text boxes whose own markup sets text under 16px (markupFontPx), found
 *  by `marker` in the box's opening tag. ★ Each STILL ZOOMS AN IPHONE, like
 *  the "zooms" entries above: size the box in its stylesheet with the phone
 *  rule and delete its entry; never add one. */
const MARKUP_ALLOW_LIST: { file: string; marker: string; reason: string }[] = [
  {
    file: "app/(storefront)/(pages)/blogs/write/write-blog-editor.tsx",
    marker: 'aria-label="Email"',
    reason:
      "The Write a blog editor's Add your email box, an inline 15px at every width.",
  },
];

/** The boxes that still zoom (the "zooms" entries and MARKUP_ALLOW_LIST)
 *  can only go: 12 when the lists were written. */
const ZOOMS_AT_MOST = 12;

// ---- tests -----------------------------------------------------------------------

describe("iPhone input zoom: the reader", () => {
  it("accepts a later 16px phone rule with the same selector", () => {
    expect(
      findingsIn(
        ".a input { font-size: 14px; } @media (max-width: 600px) { .a input { font-size: 16px; } }",
      ),
    ).toEqual([]);
  });

  it("flags a box with no phone rule, at the narrowest phone", () => {
    expect(
      findingsIn(".a input { font: inherit; font-size: 0.9rem; }"),
    ).toEqual([
      {
        file: "x.css",
        selector: ".a input",
        width: 320,
        value: "0.9rem",
        px: 14.4,
      },
    ]);
  });

  it("flags a phone rule that comes before the base rule", () => {
    expect(
      findingsIn(
        "@media (max-width: 600px) { .a input { font-size: 16px; } } .a input { font-size: 15px; }",
      ),
    ).toHaveLength(1);
  });

  it("flags a phone rule that misses some phones, or only fits desktops", () => {
    expect(
      findingsIn(
        ".a select { font-size: 15px; } @media (max-width: 400px) { .a select { font-size: 16px; } }",
      ),
    ).toMatchObject([{ width: 414 }]);
    expect(
      findingsIn(
        ".a textarea { font-size: 15px; } @media (min-width: 768px) { .a textarea { font-size: 16px; } }",
      ),
    ).toHaveLength(1);
  });

  it("flags a different selector, which has its own specificity", () => {
    expect(
      findingsIn(
        ".a input { font-size: 14px; } @media (max-width: 600px) { .b .a input { font-size: 16px; } }",
      ),
    ).toMatchObject([{ selector: ".a input" }]);
  });

  it("matches the same selector however it is spaced", () => {
    expect(
      findingsIn(
        ".a  input { font-size: 14px; } @media (max-width: 600px) { .a\n  input { font-size: 16px; } }",
      ),
    ).toEqual([]);
    expect(
      findingsIn(
        ".a>textarea { font-size: 14px; } @media (max-width: 600px) { .a > textarea { font-size: 16px; } }",
      ),
    ).toEqual([]);
  });

  it("lets an !important base rule beat a later phone rule", () => {
    expect(
      findingsIn(
        ".a input { font-size: 14px !important; } @media (max-width: 600px) { .a input { font-size: 16px; } }",
      ),
    ).toHaveLength(1);
  });

  it("counts a condition it cannot settle against the box, never for it", () => {
    // @supports and prefers-* may hold on an iPhone: a smaller size under
    // one is flagged, and a 16px rule under one fixes nothing.
    expect(
      findingsIn(
        ".a input { font-size: 16px; } @supports (display: grid) { .a input { font-size: 14px; } }",
      ),
    ).toMatchObject([{ px: 14 }]);
    expect(
      findingsIn(
        ".a input { font-size: 16px; } @media (prefers-reduced-motion: reduce) { .a input { font-size: 15px; } }",
      ),
    ).toMatchObject([{ px: 15 }]);
    expect(
      findingsIn(
        ".a input { font-size: 14px; } @supports (display: grid) { .a input { font-size: 16px; } }",
      ),
    ).toMatchObject([{ px: 14 }]);
  });

  it("reads font shorthands, clamp() at phone widths and placeholders", () => {
    expect(
      findingsIn(".a input { font: 600 14px/1.3 Inter, sans-serif; }"),
    ).toMatchObject([{ px: 14 }]);
    expect(
      findingsIn(".a input { font-size: clamp(14px, 4vw, 18px); }"),
    ).toMatchObject([{ width: 320, px: 14 }]);
    expect(
      findingsIn(".a input { font-size: calc(1rem * var(--x, 0.9)); }"),
    ).toMatchObject([{ px: 14.4 }]);
    expect(
      findingsIn(".a input::placeholder { font-size: 13px; }"),
    ).toMatchObject([{ selector: ".a input::placeholder" }]);
    expect(findingsIn(".a input { font-size: max(16px, 1rem); }")).toEqual([]);
  });

  it("ignores what is not a text box, or not on a phone", () => {
    expect(
      findingsIn(
        [
          ".a input[type='checkbox'] { font-size: 12px; }",
          ".a button { font-size: 12px; }",
          ".a input::-webkit-search-cancel-button { font-size: 12px; }",
          ".inputGroup { font-size: 12px; }",
          ".chip-selected { font-size: 12px; }",
          "@media print { .a input { font-size: 10px; } }",
          "@media (hover: hover) and (pointer: fine) { .a input { font-size: 13px; } }",
          "@media (min-width: 768px) { .a input { font-size: 13px; } }",
          ".a input { font: inherit; }",
          ".b input { font-size: var(--box-size); }",
          "@keyframes pulse { from { font-size: 10px; } }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("reads the text size a box's own markup sets", () => {
    expect(markupFontPx("<input style={{ fontSize: 15, padding: 4 }} />")).toBe(
      15,
    );
    expect(markupFontPx('<input style={{ fontSize: "0.9rem" }} />')).toBe(14.4);
    expect(markupFontPx('<textarea className="w-full text-sm" />')).toBe(14);
    expect(
      markupFontPx("<select className={`p-2 text-[15px] ${open}`} />"),
    ).toBe(15);
    expect(markupFontPx('<input className="text-base md:text-sm" />')).toBe(
      null,
    );
    expect(
      markupFontPx(
        '<input className="text-[var(--ink)]" style={{ fontSize: size }} />',
      ),
    ).toBe(null);
    const src = [
      '<input type="checkbox" style={{ fontSize: 12 }} />',
      "<input style={{ fontSize: 16 }} />",
      '<textarea className="note text-xs" />',
    ].join("\n");
    expect(markupFindings(["x.tsx"], () => src)).toEqual([
      'x.tsx: 12px in <textarea className="note text-xs" />',
    ]);
  });

  it("finds a box by its class name or by the markup", () => {
    expect(findingsIn(".searchInput { font-size: 14px; }")).toHaveLength(1);
    expect(
      findingsIn(".pdp-review-textarea { font-size: 0.92rem; }"),
    ).toHaveLength(1);
    // The return form's quantity select has no telling name: only the
    // markup says it is a box.
    const sheet = "app/(storefront)/(pages)/orders/orders.module.css";
    const markup = scanMarkup([
      "app/(storefront)/(pages)/orders/[id]/return-request.tsx",
    ]);
    expect(Array.from(markup.moduleBoxes.get(sheet) ?? []).sort()).toEqual([
      "returnQty",
      "returnSwap",
    ]);
    expect(
      scanSheet(sheet, ".returnQty { font-size: 0.85rem; }", markup).findings,
    ).toHaveLength(1);
    expect(findingsIn(".returnQty { font-size: 0.85rem; }")).toEqual([]);
  });

  it("reads which classes the markup puts on a text box", () => {
    const src = [
      'import s from "./form.module.css";',
      'import t from "@/app/shared/other.module.css";',
      '<input type="checkbox" className={s.tick} onChange={(e) => go(e.target.value > 1)} />',
      "<input className={`${s.box} ${t.wide}`} />",
      '<textarea className="note-area plain" />',
      '<PhoneInput className="row-wrap" numberInputProps={{ className: s.phone }} />',
      "<div className={s.unused} />",
    ].join("\n");
    const markup = scanMarkup(["app/x/form.tsx"], () => src);
    expect(
      Array.from(markup.moduleBoxes.get("app/x/form.module.css") ?? []),
    ).toEqual(["box", "phone"]);
    expect(
      Array.from(markup.moduleBoxes.get("app/shared/other.module.css") ?? []),
    ).toEqual(["wide"]);
    expect(Array.from(markup.globalBoxes)).toEqual(["note-area", "plain"]);
    expect(markup.moduleRefs.get("app/x/form.module.css")).toEqual(
      new Set(["tick", "box", "phone", "unused"]),
    );
  });

  it("looks through :not() and :global() to the element itself", () => {
    expect(
      findingsIn('.a input:not([type="checkbox"]) { font-size: 14px; }'),
    ).toHaveLength(1);
    expect(
      findingsIn(":global(.dark) .b input { font-size: 14px; }"),
    ).toHaveLength(1);
    expect(
      findingsIn(":global(.coupon-input) { font-size: 14px; }"),
    ).toHaveLength(1);
    expect(findingsIn(".a:not(.big-input) { font-size: 14px; }")).toEqual([]);
  });

  it("reads hover, pointer and width range media features", () => {
    const phone = PHONES[0];
    expect(atRuleHolds("@media (pointer: coarse)", phone)).toBe(true);
    expect(atRuleHolds("@media (hover: hover)", phone)).toBe(false);
    expect(atRuleHolds("@media (width <= 600px)", phone)).toBe(true);
    expect(atRuleHolds("@media (600px >= width)", DESKTOP)).toBe(false);
    expect(atRuleHolds("@media (prefers-reduced-motion: reduce)", phone)).toBe(
      "unknown",
    );
    expect(atRuleHolds("@media print, (max-width: 37.5em)", phone)).toBe(true);
    expect(atRuleHolds("@media not all and (min-width: 601px)", phone)).toBe(
      true,
    );
    expect(atRuleHolds("@media not all and (min-width: 601px)", DESKTOP)).toBe(
      false,
    );
  });
});

describe("iPhone input zoom: the six boxes fixed on 25 Oct 2026", () => {
  const markup = scanMarkup(MARKUP);
  for (const b of BOXES) {
    it(`${b.box}: a phone rule keeps it at 16px or more`, () => {
      const { rules, boxSelectors } = scanSheet(b.css, read(b.css), markup);
      expect(
        boxSelectors,
        `the reader no longer sees ${b.selector} as a text box`,
      ).toContain(b.selector);
      const phoneRule = rules.find((rule) => {
        const decl = fontDecl(rule);
        return (
          rule.selectors.includes(b.selector) &&
          decl !== null &&
          (declPx(decl, PHONES[0]) ?? 0) >= IOS_MIN_PX &&
          PHONES.every((p) => applies(rule, p) === true) &&
          applies(rule, DESKTOP) === false
        );
      });
      expect(
        phoneRule,
        `${b.css} lost "@media (max-width: 600px) { ${b.selector} { font-size: 16px; } }": iPhones zoom the page when this box takes focus`,
      ).toBeDefined();
      for (const phone of PHONES) {
        expect(
          sizeAt(rules, b.selector, phone)?.px,
          `${b.selector} at ${phone.width}px wide`,
        ).toBeGreaterThanOrEqual(IOS_MIN_PX);
      }
      expect(
        b.shows(read(b.markup)),
        `${b.markup} no longer renders this box`,
      ).toBe(true);
    });
  }

  it("each box's markup check fails on markup without the box", () => {
    for (const b of BOXES)
      expect(b.shows("<form><input /></form>"), b.box).toBe(false);
    // A box moved out of its form no longer gets the form's rule; however
    // the form's opening tag is spread over lines, a box inside it counts.
    const search = 'className="sf404-search"';
    expect(
      inside(`<form ${search}></form><input />`, "form", search, "<input"),
    ).toBe(false);
    expect(
      inside(
        `<form\n  role="search"\n  ${search}\n  action="/shop"\n>\n  <input />\n</form>`,
        "form",
        search,
        "<input",
      ),
    ).toBe(true);
    expect(
      inside(`<form ${search}><input /></form>`, "form", "other", "<input"),
    ).toBe(false);
  });
});

describe("iPhone input zoom: every stylesheet and box a storefront page loads", () => {
  const markup = scanMarkup(MARKUP);
  const findings = STYLESHEETS.flatMap(
    (file) => scanSheet(file, read(file), markup).findings,
  );
  const key = (f: { file: string; selector: string }) =>
    `${f.file}  ${f.selector}`;

  it("keeps every text box at 16px or more on phones, or explains why not", () => {
    const allowed = new Set(ALLOW_LIST.map(key));
    expect(
      findings
        .filter((f) => !allowed.has(key(f)))
        .map((f) => `${key(f)}: ${f.value} (${f.px}px) at ${f.width}px wide`),
      'iPhones zoom the page when these take focus. Add, after each rule: "@media (max-width: 600px) { <selector> { font-size: 16px; } }"',
    ).toEqual([]);
  });

  it("has no allow-list entry for a box that is fixed or gone", () => {
    const found = new Set(findings.map(key));
    expect(ALLOW_LIST.filter((a) => !found.has(key(a))).map(key)).toEqual([]);
    for (const a of ALLOW_LIST)
      expect(a.reason.length, key(a)).toBeGreaterThan(20);
    expect(new Set(ALLOW_LIST.map(key)).size).toBe(ALLOW_LIST.length);
  });

  it("never grows the list of boxes that still zoom", () => {
    expect(
      ALLOW_LIST.filter((a) => a.kind === "zooms").length +
        MARKUP_ALLOW_LIST.length,
      "Give a new box its 16px phone rule instead of an allow-list entry",
    ).toBeLessThanOrEqual(ZOOMS_AT_MOST);
  });

  it("sets no text under 16px in a text box's own markup, or explains why", () => {
    const files = storefrontMarkup();
    // The shared components a storefront page imports count; the
    // dashboard's do not.
    expect(files).toContain("components/ui/phone-country-select.tsx");
    expect(files).not.toContain("components/customer-multiselect.tsx");
    expect(
      markupFindings(files),
      "iPhones zoom the page when these take focus: size the box in its stylesheet, with a 16px phone rule. A fixed box's entry goes.",
    ).toEqual(MARKUP_ALLOW_LIST.map((a) => `${a.file}  ${a.marker}`).sort());
    for (const a of MARKUP_ALLOW_LIST)
      expect(a.reason.length, a.file).toBeGreaterThan(20);
  });

  it("allow-lists as unused only classes no markup uses", () => {
    for (const a of ALLOW_LIST.filter((entry) => entry.kind === "unused")) {
      const name = a.selector.replace(/^\./, "");
      expect(markup.moduleRefs.has(a.file), `${a.file} has no importer`).toBe(
        true,
      );
      expect(
        markup.moduleRefs.get(a.file)?.has(name),
        `${key(a)} is used now`,
      ).toBe(false);
    }
  });

  it("allow-lists the header's search box only while phones cannot see it", () => {
    const file = "app/(storefront)/components/header/Header.module.css";
    const rules = parseCss(read(file));
    for (const phone of PHONES) {
      const display = rules
        .filter(
          (r) =>
            r.selectors.includes(".searchWrap:not(.searchWrapSheet)") &&
            applies(r, phone) === true,
        )
        .flatMap((r) => r.decls.filter((d) => d.prop === "display"))
        .pop();
      expect(
        display?.value,
        `the header search box shows at ${phone.width}px`,
      ).toBe("none");
      expect(
        sizeAt(rules, ".searchWrapSheet .searchInput", phone)?.px,
      ).toBeGreaterThanOrEqual(IOS_MIN_PX);
    }
    expect(ALLOW_LIST.filter((a) => a.kind === "hidden").map(key)).toEqual([
      `${file}  .searchInput`,
    ]);
  });

  it("keeps 1rem at 16px: no stylesheet resizes the root", () => {
    for (const file of STYLESHEETS) {
      for (const rule of parseCss(read(file))) {
        if (rule.selectors.some((s) => /^(html|:root)$/.test(s)))
          expect(fontDecl(rule), `${file} sets the root font size`).toBeNull();
      }
    }
  });

  it("never turns zoom off (no maximum-scale or user-scalable)", () => {
    for (const file of [
      "app/layout.tsx",
      ...walk("app/(storefront)", isSource),
    ]) {
      expect(read(file), file).not.toMatch(/maximum-?scale|user-?scalable/i);
    }
  });
});
