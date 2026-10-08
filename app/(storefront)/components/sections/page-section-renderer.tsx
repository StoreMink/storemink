import type { PageSectionItem } from "@/lib/sections/registry";
import { closingSectionType } from "@/lib/sections/closing-section";
import {
  HomepageSectionRenderer,
  type ResolvedData,
} from "../homepage/homepage-section-renderer";

// Renders a store page's sections array (store_pages.sections /
// published_sections) with the same renderer + resolved-data machinery the
// homepage uses. Disabled sections are skipped here so callers can pass the
// stored array as-is.
export function PageSectionRenderer({
  sections,
  resolved,
}: {
  sections: PageSectionItem[];
  resolved: ResolvedData;
}) {
  const visible = sections.filter((s) => s.enabled);
  if (visible.length === 0) return null;
  // The footer carries the store's own signup form, so a page that closes on
  // a newsletter section would end with two forms back to back. The attribute
  // lets storefront-theme.css hide the footer's copy on exactly that page.
  const closing = closingSectionType(visible);
  return (
    <div
      className="home-sections"
      {...(closing === "newsletter" ? { "data-sm-closing": "newsletter" } : {})}
    >
      {visible.map((s) => (
        <HomepageSectionRenderer key={s.id} section={s} resolved={resolved} />
      ))}
    </div>
  );
}
