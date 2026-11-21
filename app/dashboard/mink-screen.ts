import {
  redactScreenField,
  redactScreenText,
  SCREEN_CELL_SEPARATOR,
} from "@/lib/mink/screen-redaction";

/**
 * What the merchant can see right now, read off the dashboard DOM and sent
 * with each message so Mink can resolve "this", "these" and "the one on
 * screen" the way Sidekick does.
 *
 * ★ BOUNDED, NEVER AUTHORITY. The server treats it as untrusted reference
 * data (a separate part before the message, like approved memories) and
 * every figure or proposal is still verified with a tool. Secrets never
 * leave the page: password, hidden and file inputs are skipped, and so is
 * any field whose label names a key, token, secret, OTP or PIN. The Mink
 * panel itself is excluded, or the conversation would be fed back into
 * itself.
 *
 * ★★ NEITHER DO CONTACT DETAILS (owner's decision, 25 Oct 2026). Every string
 * passes through lib/mink/screen-redaction.ts before it is cut to length, so
 * an email reads "[email hidden]", a phone "[phone hidden]" and a postal
 * address "[address hidden]"; names and order details stay. The server masks
 * again, for tabs opened before this shipped.
 */
export interface MinkScreenContext {
  title?: string;
  headings?: string[];
  query?: Record<string, string>;
  dialog?: string;
  notice?: string;
  rows?: string[];
  selectedCount?: number;
  fields?: Array<{ label: string; value: string }>;
}

const LIMITS = {
  title: 120,
  heading: 80,
  headings: 5,
  queryKeys: 10,
  queryValue: 60,
  dialog: 120,
  notice: 200,
  row: 160,
  rows: 20,
  fieldLabel: 60,
  fieldValue: 200,
  fields: 40,
} as const;

const SECRET_LABEL =
  /password|secret|token|api key|key id|otp|\bpin\b|credential/i;
// The chat itself and the top-bar "Ask Mink AI" bar: neither is page content
// (the bar holds Mink's own suggestion and the merchant's unsent draft).
const PANEL = ".mink-chat-surface, [data-mink-dock]";

function collapse(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function clean(value: string | null | undefined, max: number): string {
  const text = collapse(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Masked, then cut: a cut through an email or phone would leave a fragment. */
function safe(value: string | null | undefined, max: number): string {
  return clean(redactScreenText(value ?? ""), max);
}

/**
 * An element's text with a space at every element boundary. textContent
 * joins a cell's parts with nothing between them, so "Priya Sharma" beside
 * "priya@example.com" read "Priya Sharmapriya@example.com" and the email
 * took the surname with it, and a phone after a name ("Rahul9876543210")
 * read as part of a code and was not hidden.
 */
function textOf(node: Node | null | undefined): string {
  let text = "";
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
    else if (child.nodeType === Node.ELEMENT_NODE) text += ` ${textOf(child)} `;
  }
  return text;
}

function visible(element: Element): boolean {
  if (element.closest(PANEL) || element.closest("[hidden]")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function escapeId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/["\\]/g, "\\$&");
}

function labelFor(control: Element): string {
  const aria = control.getAttribute("aria-label");
  if (aria) return aria;
  const id = control.getAttribute("id");
  if (id) {
    const label = document.querySelector(`label[for="${escapeId(id)}"]`);
    const text = textOf(label);
    if (text.trim()) return text;
  }
  return textOf(control.closest("label"));
}

/** The current screen, or null outside a browser. Cheap enough to run per message. */
export function readMinkScreen(): MinkScreenContext | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  const screen: MinkScreenContext = {};
  const title = safe(document.title, LIMITS.title);
  if (title) screen.title = title;

  const headings = Array.from(
    document.querySelectorAll<HTMLElement>("main h1, main h2"),
  )
    .filter(
      (heading) => visible(heading) && !heading.closest("[role='dialog']"),
    )
    .map((heading) => safe(textOf(heading), LIMITS.heading))
    .filter(Boolean)
    .slice(0, LIMITS.headings);
  if (headings.length) screen.headings = headings;

  const params = new URLSearchParams(window.location.search);
  const query: Record<string, string> = {};
  let keys = 0;
  for (const [key, value] of params) {
    if (keys >= LIMITS.queryKeys) break;
    if (key === "prefill") continue;
    // A search box writes what was typed here, an email or a phone included.
    const cleanKey = safe(key, 30);
    const cleanValue = safe(value, LIMITS.queryValue);
    if (!cleanKey || !cleanValue) continue;
    query[cleanKey] = cleanValue;
    keys += 1;
  }
  if (keys) screen.query = query;

  const dialog = Array.from(
    document.querySelectorAll<HTMLElement>("[role='dialog'], dialog[open]"),
  ).find(visible);
  if (dialog) {
    const heading = dialog.querySelector("h1, h2, h3, [id$='-title']");
    const dialogTitle = safe(
      heading ? textOf(heading) : dialog.getAttribute("aria-label"),
      LIMITS.dialog,
    );
    if (dialogTitle) screen.dialog = dialogTitle;
  }

  const notice = Array.from(
    document.querySelectorAll<HTMLElement>("[role='alert'], [role='status']"),
  ).find(visible);
  const noticeText = notice ? safe(textOf(notice), LIMITS.notice) : "";
  if (noticeText) screen.notice = noticeText;

  const rows: string[] = [];
  const tables = Array.from(
    document.querySelectorAll<HTMLTableElement>("main table"),
  );
  for (const table of tables) {
    if (!visible(table)) continue;
    for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
      if (rows.length >= LIMITS.rows) break;
      // Each cell is masked whole, before its 60-character cut and before
      // the row's own, and an address hides only the cell it is in.
      const cells = Array.from(row.querySelectorAll("th, td"))
        .slice(0, 5)
        .map((cell) => safe(textOf(cell), 60))
        .filter(Boolean);
      const text = clean(cells.join(SCREEN_CELL_SEPARATOR), LIMITS.row);
      if (text) rows.push(text);
    }
    if (rows.length >= LIMITS.rows) break;
  }
  if (rows.length) screen.rows = rows;

  const selectedCount = document.querySelectorAll(
    "main tbody input[type='checkbox']:checked",
  ).length;
  if (selectedCount) screen.selectedCount = selectedCount;

  const fields: Array<{ label: string; value: string }> = [];
  const controls = Array.from(
    document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("main input, main textarea, main select"),
  );
  for (const control of controls) {
    if (fields.length >= LIMITS.fields) break;
    if (!visible(control)) continue;
    const type = control instanceof HTMLInputElement ? control.type : "";
    if (["password", "hidden", "file", "submit", "button"].includes(type)) {
      continue;
    }
    if ((control.getAttribute("autocomplete") ?? "").includes("password")) {
      continue;
    }
    // Judged on the whole label: a secret or an address word past the
    // 60-character cut still counts.
    const label = collapse(labelFor(control));
    if (!label || SECRET_LABEL.test(label)) continue;
    let value: string;
    if (
      control instanceof HTMLInputElement &&
      (type === "checkbox" || type === "radio")
    ) {
      if (type === "radio" && !control.checked) continue;
      value = control.checked ? "on" : "off";
    } else {
      // An address field's whole value is hidden; any other is masked.
      const raw = collapse(
        control instanceof HTMLSelectElement
          ? (control.selectedOptions[0]?.textContent ?? control.value)
          : control.value,
      );
      value = clean(redactScreenField(label, raw), LIMITS.fieldValue);
    }
    if (!value) continue;
    fields.push({ label: safe(label, LIMITS.fieldLabel), value });
  }
  if (fields.length) screen.fields = fields;

  return Object.keys(screen).length ? screen : null;
}
