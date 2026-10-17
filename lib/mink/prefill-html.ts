/**
 * A blog body Mink wrote, as the HTML the blog editor takes.
 *
 * The body arrives as plain text or simple Markdown (the contract says so in
 * `form-prefill.ts`). The editor stores HTML, so this turns the text into the
 * few blocks TipTap renders: paragraphs, one heading level and bullet lists.
 *
 * ★ ESCAPED BEFORE ANY TAG IS ADDED, so a `<script>` in the text becomes
 * visible text and never markup. The save path sanitises again
 * (`sanitizeBlogContent`); this is the first fence, not the only one.
 *
 * ★ PURE AND CLIENT-SAFE: no DOM, no imports, so the editor dialog and a node
 * test call the same function.
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeMinkText(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const HEADING = /^#{1,3}\s+(.+)$/;
const BULLET = /^[-*]\s+(.+)$/;

/**
 * Blank-line-separated paragraphs become `<p>`, a `#`/`##` line becomes
 * `<h2>`, and a run of `- ` lines becomes `<ul><li>`. Single line breaks
 * inside a paragraph are kept as `<br>`. Anything else is text.
 */
export function minkPrefillBodyToHtml(body: string): string {
  const normalized = body.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const html: string[] = [];
  for (const block of normalized.split(/\n[ \t]*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    let index = 0;
    while (index < lines.length) {
      const heading = HEADING.exec(lines[index]);
      if (heading) {
        html.push(`<h2>${escapeMinkText(heading[1].trim())}</h2>`);
        index += 1;
        continue;
      }
      if (BULLET.test(lines[index])) {
        const items: string[] = [];
        while (index < lines.length) {
          const item = BULLET.exec(lines[index]);
          if (!item) break;
          items.push(`<li>${escapeMinkText(item[1].trim())}</li>`);
          index += 1;
        }
        html.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
      const paragraph: string[] = [];
      while (
        index < lines.length &&
        !HEADING.test(lines[index]) &&
        !BULLET.test(lines[index])
      ) {
        paragraph.push(escapeMinkText(lines[index]));
        index += 1;
      }
      html.push(`<p>${paragraph.join("<br>")}</p>`);
    }
  }
  return html.join("");
}
