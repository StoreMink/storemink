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
const PANEL = ".mink-chat-surface";

function clean(value: string | null | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
    if (label?.textContent) return label.textContent;
  }
  const wrapping = control.closest("label");
  return wrapping?.textContent ?? "";
}

/** The current screen, or null outside a browser. Cheap enough to run per message. */
export function readMinkScreen(): MinkScreenContext | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  const screen: MinkScreenContext = {};
  const title = clean(document.title, LIMITS.title);
  if (title) screen.title = title;

  const headings = Array.from(
    document.querySelectorAll<HTMLElement>("main h1, main h2"),
  )
    .filter(
      (heading) => visible(heading) && !heading.closest("[role='dialog']"),
    )
    .map((heading) => clean(heading.textContent, LIMITS.heading))
    .filter(Boolean)
    .slice(0, LIMITS.headings);
  if (headings.length) screen.headings = headings;

  const params = new URLSearchParams(window.location.search);
  const query: Record<string, string> = {};
  let keys = 0;
  for (const [key, value] of params) {
    if (keys >= LIMITS.queryKeys) break;
    if (key === "prefill") continue;
    const cleanKey = clean(key, 30);
    const cleanValue = clean(value, LIMITS.queryValue);
    if (!cleanKey || !cleanValue) continue;
    query[cleanKey] = cleanValue;
    keys += 1;
  }
  if (keys) screen.query = query;

  const dialog = Array.from(
    document.querySelectorAll<HTMLElement>("[role='dialog'], dialog[open]"),
  ).find(visible);
  if (dialog) {
    const dialogTitle = clean(
      dialog.querySelector("h1, h2, h3, [id$='-title']")?.textContent ??
        dialog.getAttribute("aria-label"),
      LIMITS.dialog,
    );
    if (dialogTitle) screen.dialog = dialogTitle;
  }

  const notice = Array.from(
    document.querySelectorAll<HTMLElement>("[role='alert'], [role='status']"),
  ).find(visible);
  const noticeText = notice ? clean(notice.textContent, LIMITS.notice) : "";
  if (noticeText) screen.notice = noticeText;

  const rows: string[] = [];
  const tables = Array.from(
    document.querySelectorAll<HTMLTableElement>("main table"),
  );
  for (const table of tables) {
    if (!visible(table)) continue;
    for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
      if (rows.length >= LIMITS.rows) break;
      const cells = Array.from(row.querySelectorAll("th, td"))
        .slice(0, 5)
        .map((cell) => clean(cell.textContent, 60))
        .filter(Boolean);
      const text = clean(cells.join(" · "), LIMITS.row);
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
    const label = clean(labelFor(control), LIMITS.fieldLabel);
    if (!label || SECRET_LABEL.test(label)) continue;
    let value: string;
    if (
      control instanceof HTMLInputElement &&
      (type === "checkbox" || type === "radio")
    ) {
      if (type === "radio" && !control.checked) continue;
      value = control.checked ? "on" : "off";
    } else if (control instanceof HTMLSelectElement) {
      value = clean(
        control.selectedOptions[0]?.textContent ?? control.value,
        LIMITS.fieldValue,
      );
    } else {
      value = clean(control.value, LIMITS.fieldValue);
    }
    if (!value) continue;
    fields.push({ label, value });
  }
  if (fields.length) screen.fields = fields;

  return Object.keys(screen).length ? screen : null;
}
