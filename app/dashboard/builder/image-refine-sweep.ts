import type { PageSectionItem } from "@/lib/sections/registry";

/** What the Website Builder holds now, as the refine sweep reads it. */
export interface BuilderRefineState {
  /** The open page's id (a draft's id is its page's id), or null. */
  draftId: string | null;
  /** The open page's sections. */
  sections: readonly PageSectionItem[];
  /** Every page the builder lists. */
  pageIds: readonly string[];
  /** The store's header and footer, and its brand: the chrome scope's photos. */
  chrome: unknown;
  brand: unknown;
}

/** The refine scope of the builder's header, footer and brand forms. */
export const BUILDER_CHROME_REFINE_SCOPE = "builder:chrome";

/**
 * The refine scope of a section's form on a page,
 * `builder:{pageId}:{sectionId}`. ★ The inspector builds its scopes here and
 * builderRefineStillWanted below reads them, so the two cannot disagree: a
 * builder scope the sweep cannot read is released, which would stop every
 * builder refine at the next edit.
 */
export function builderSectionRefineScope(
  pageId: string,
  sectionId: string,
): string {
  return `builder:${pageId}:${sectionId}`;
}

/**
 * Whether a Refine with Mink AI request started in the Website Builder still
 * has a slot to land in. The builder releases (stops) every refine this
 * answers false for (builder-client.tsx, one effect over the draft, the page
 * list, the chrome and the brand).
 *
 * ★ A SLOT IS DESTROYED, NOT MERELY HIDDEN. A refine's box unmounts on
 *   ordinary editing (another tab, a collapsed group, another section,
 *   another page), and none of that stops it. It is released only when its
 *   photo leaves the place its scope names: the section is deleted, the
 *   block, slide, gallery image or tile holding the photo is removed or set
 *   to another photo (undo and redo included), the header, footer or brand
 *   no longer holds it, or its page is deleted.
 * ★ ANOTHER PAGE IS KEPT WHILE IT EXISTS. Switching pages replaces the open
 *   draft and destroys nothing, and the "ready" toast says to go back to that
 *   image; the section and photo checks apply again when that page is open.
 * ★ The photo is found by its URL in the section's config JSON (true of every
 *   builder image field today). A field that kept images elsewhere would see
 *   its refines stopped, which fails safe: a stop charges nothing.
 */
export function builderRefineStillWanted(
  refine: { scope: string; sourceUrl: string },
  state: BuilderRefineState,
): boolean {
  if (!refine.scope.startsWith("builder:")) return true;
  // The URL as it appears inside a JSON string.
  const needle = JSON.stringify(refine.sourceUrl).slice(1, -1);
  if (refine.scope === BUILDER_CHROME_REFINE_SCOPE) {
    return JSON.stringify([state.chrome, state.brand]).includes(needle);
  }
  // `builder:{pageId}:{sectionId}`: a page id (a UUID) holds no colon, the
  // section id is the rest, whatever it holds.
  const rest = refine.scope.slice("builder:".length);
  const colon = rest.indexOf(":");
  if (colon < 0) return false;
  const pageId = rest.slice(0, colon);
  const sectionId = rest.slice(colon + 1);
  if (pageId !== state.draftId) return state.pageIds.includes(pageId);
  const section = state.sections.find((item) => item.id === sectionId);
  return (
    section !== undefined && JSON.stringify(section.config).includes(needle)
  );
}
