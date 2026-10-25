// Renders one or more JSON-LD schema.org objects as a <script> tag. Builders
// live in lib/seo/schema.ts (pure + tested) and the escaping in
// lib/seo/json-ld.ts, which the platform pages share. Passing an array emits a
// single script with a JSON array, which crawlers parse as multiple graph
// nodes.

import { serializeJsonLd, type JsonLdData } from "@/lib/seo/json-ld";

// ★ Re-exported so code importing them from here keeps working. They moved
// to lib/seo so a platform page (apex, POS, themes, help) escapes its own
// script without importing from the storefront folder.
export { serializeJsonLd };
export type { JsonLdData };

export function JsonLd({ data }: { data: JsonLdData }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
