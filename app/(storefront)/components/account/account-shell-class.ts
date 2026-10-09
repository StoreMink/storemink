import type { AccountTemplate } from "@/lib/themes/templates";

/** The shell's root classes, or "" when the template changes nothing (the
 *  plain layout with the page's own colours), so the page renders bare. */
export function accountShellClass(template: AccountTemplate): string {
  if (template.layout === "plain" && !template.scheme) return "";
  return [
    "sm-account",
    `layout-${template.layout}`,
    template.scheme ? `sm-scheme sm-scheme-${template.scheme}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
