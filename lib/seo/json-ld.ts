// The one serializer for every <script type="application/ld+json"> StoreMink
// writes: the storefront's <JsonLd> component
// (app/(storefront)/components/json-ld.tsx) and the platform pages that write
// their own script (the apex, POS, themes and help hosts). Pure and
// import-free, so a page on any host can use it, server or client.
// lib/seo/json-ld-coverage.test.ts fails when a file writes that script any
// other way.

export type JsonLdData = Record<string, unknown> | Record<string, unknown>[];

// ★★ THE VALUES ARE TEXT SOMEONE TYPED, SO THE MARKUP IS ESCAPED. A store
// blurb, a product description, a category or blog title, a Mink revamp's
// copy and a Theme Studio theme name all land in here. An HTML parser ends a
// <script> element at the first "</script" whatever JSON thinks is a string,
// and "<!--<script>" stops it ending at its own closing tag, so a bare
// JSON.stringify let one value close the element and run markup on the
// page's origin (a store's origin also serves /dashboard and /pos).
// JSON.stringify only ever emits these characters inside a string, where the
// JSON unicode escape means the same character, so crawlers read identical
// data and the HTML tokenizer has nothing left to act on. The two line
// separators are escaped too, for any consumer that still reads JSON as
// JavaScript.
const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

export function serializeJsonLd(data: JsonLdData): string {
  return JSON.stringify(data).replace(
    SCRIPT_UNSAFE,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
