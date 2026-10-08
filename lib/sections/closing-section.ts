// Which section type a page ENDS on, counting only enabled sections. The
// footer renders its own newsletter form on every page, so a page whose last
// band is a newsletter section would show two signup forms back to back; the
// renderer marks such a page and the footer's form is hidden there (the
// `data-sm-closing` rule in storefront-theme.css). Pure, so the rule is
// testable without rendering seventeen section components.
export function closingSectionType(
  sections: readonly { type: string; enabled?: boolean }[],
): string | null {
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (section.enabled === false) continue;
    return section.type;
  }
  return null;
}
