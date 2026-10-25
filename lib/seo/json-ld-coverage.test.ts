import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, posix } from "path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: every JSON-LD script is written by serializeJsonLd.
//
// A <script type="application/ld+json"> carries text someone typed: a product
// description, a store blurb, a Mink revamp's copy, a Theme Studio theme name.
// An HTML parser ends that element at the first "</script" whatever JSON
// thinks is a string, so a bare JSON.stringify lets one value close the
// element and run markup on the page's origin. lib/seo/json-ld.ts escapes the
// characters that matter (lib/seo/json-ld.test.ts proves it). The storefront
// was moved onto it first, and the platform pages (apex, POS, themes, help)
// kept a bare JSON.stringify of their own, the POS page escaping "<" alone.
// Nothing stops the next page writing one except this test.
//
// ★ ONE SHAPE PASSES, whatever the tag:
//   <script type="application/ld+json"
//     dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />
// with serializeJsonLd imported from the shared module. A storefront page
// renders <JsonLd data={...} />, which is that shape in one place. Any other
// appearance of the type (createElement, an HTML string, a constant) fails
// too, because how its script is written cannot be checked.
// ---------------------------------------------------------------------------

const SCAN_DIRS = ["app", "components", "lib", "hooks"];

/** Where the shared serializeJsonLd lives, and the storefront module that re-exports it. */
const SERIALIZER_MODULES = new Set([
  "lib/seo/json-ld",
  "app/(storefront)/components/json-ld",
]);

// The MIME type is matched without regard to case, as a parser reads it.
const JSON_LD_TYPE = /ld\+json/i;

const HOW_TO_FIX =
  'A JSON-LD script holds text someone typed, and a "</script>" in it ends a ' +
  "script written by a bare JSON.stringify. Write it as " +
  '<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ' +
  'serializeJsonLd(data) }} /> with serializeJsonLd from "@/lib/seo/json-ld", ' +
  "or render <JsonLd data={data} /> on a storefront page.";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (
      /\.(ts|tsx|mts|mjs|js|jsx)$/.test(full) &&
      !full.includes(".test.")
    )
      out.push(full);
  }
  return out;
}

/** A module specifier as a repo path without its extension, or null for a package. */
function moduleKey(fromFile: string, specifier: string): string | null {
  const bare = specifier.replace(/\.(ts|tsx|js|jsx)$/, "");
  if (bare.startsWith("@/")) return bare.slice(2);
  if (bare.startsWith(".")) return posix.join(posix.dirname(fromFile), bare);
  return null;
}

/** The local names this file's imports bind to the shared serializeJsonLd. */
function serializerNames(file: string, source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    // A type-only import binds nothing at runtime, so it cannot be the
    // function that escapes the script.
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    )
      continue;
    const key = moduleKey(file, statement.moduleSpecifier.text);
    if (!key || !SERIALIZER_MODULES.has(key)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (!specifier.isTypeOnly && imported === "serializeJsonLd")
        names.add(specifier.name.text);
    }
  }
  return names;
}

/** The JSX element whose `type` attribute this literal is, if it is one. */
function elementTypedBy(
  literal: ts.Node,
  source: ts.SourceFile,
): ts.JsxOpeningLikeElement | null {
  let attribute = literal.parent;
  if (ts.isJsxExpression(attribute)) attribute = attribute.parent;
  if (
    !ts.isJsxAttribute(attribute) ||
    attribute.name.getText(source) !== "type"
  )
    return null;
  const element = attribute.parent.parent;
  return ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)
    ? element
    : null;
}

/** True only for `dangerouslySetInnerHTML={{ __html: serializeJsonLd(...) }}`. */
function writtenBySerializer(
  element: ts.JsxOpeningLikeElement,
  names: Set<string>,
  source: ts.SourceFile,
): boolean {
  const attributes = element.attributes.properties;
  // A spread can replace the markup after it, so nothing about it is known.
  if (attributes.some(ts.isJsxSpreadAttribute)) return false;
  const markup = attributes.find(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText(source) === "dangerouslySetInnerHTML",
  );
  if (!markup || !ts.isJsxAttribute(markup)) return false;
  const value = markup.initializer;
  if (
    !value ||
    !ts.isJsxExpression(value) ||
    !value.expression ||
    !ts.isObjectLiteralExpression(value.expression) ||
    value.expression.properties.length !== 1
  )
    return false;
  const [html] = value.expression.properties;
  return (
    ts.isPropertyAssignment(html) &&
    html.name.getText(source) === "__html" &&
    ts.isCallExpression(html.initializer) &&
    ts.isIdentifier(html.initializer.expression) &&
    names.has(html.initializer.expression.text)
  );
}

/** Every JSON-LD script in the file not written by the shared serializer, as "file:line: why". */
function jsonLdOffences(file: string, text: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const names = serializerNames(file, source);
  const offences: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      JSON_LD_TYPE.test(node.text)
    ) {
      const element = elementTypedBy(node, source);
      const why = !element
        ? "names the JSON-LD type outside a JSX type attribute, so how its script is written cannot be checked"
        : writtenBySerializer(element, names, source)
          ? null
          : "writes a JSON-LD script without serializeJsonLd from lib/seo/json-ld";
      if (why) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        offences.push(`${file}:${line + 1}: ${why}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offences;
}

let scanned: { files: string[]; writers: { file: string; text: string }[] };
function scan() {
  if (!scanned) {
    const files = SCAN_DIRS.flatMap((dir) => sourceFiles(dir));
    const writers = files
      .map((file) => ({ file, text: readFileSync(file, "utf8") }))
      .filter(({ text }) => JSON_LD_TYPE.test(text));
    scanned = { files, writers };
  }
  return scanned;
}

const SAFE_SCRIPT =
  '<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />';
const SHARED_IMPORT = 'import { serializeJsonLd } from "@/lib/seo/json-ld";';
const PAGE = "app/example/page.tsx";
const lines = (...source: string[]) => source.join("\n");

describe("★★ every JSON-LD script is written by serializeJsonLd", () => {
  it("finds the writers it guards, so a broken scan cannot pass silently", () => {
    const { files, writers } = scan();
    expect(files.length).toBeGreaterThan(500);
    expect(writers.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "app/(storefront)/components/json-ld.tsx",
        "app/help/layout.tsx",
        "app/platform/page.tsx",
        "app/platform/pos/page.tsx",
        "app/themes/page.tsx",
      ]),
    );
  });

  it("escapes every one of them through the shared serializer", () => {
    const offences = scan().writers.flatMap(({ file, text }) =>
      jsonLdOffences(file, text),
    );
    expect(offences, HOW_TO_FIX).toEqual([]);
  });

  // ★ The check itself, against each shape it has to refuse. Without these a
  // checker that passed everything would pass the scan above too.
  it.each([
    {
      name: "a bare JSON.stringify",
      source: lines(
        SHARED_IMPORT,
        'export const Ld = () => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;',
      ),
    },
    {
      name: "an escape of one character, as the POS page had",
      source: lines(
        'export const Ld = () => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, LT) }} />;',
      ),
    },
    {
      name: "the type in capitals",
      source: lines(
        'export const Ld = () => <script type="application/LD+JSON" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;',
      ),
    },
    {
      name: "a type in braces",
      source: lines(
        'export const Ld = () => <script type={"application/ld+json"} dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;',
      ),
    },
    {
      name: "a rewrite of the serializer's output",
      source: lines(
        SHARED_IMPORT,
        'export const Ld = () => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data).replaceAll(ESCAPED_LT, "<") }} />;',
      ),
    },
    {
      name: "a look-alike serializer defined in the file",
      source: lines(
        "function serializeJsonLd(data: object) { return JSON.stringify(data); }",
        `export const Ld = () => ${SAFE_SCRIPT};`,
      ),
    },
    {
      name: "a serializer imported from another module",
      source: lines(
        'import { serializeJsonLd } from "@/lib/seo/schema";',
        `export const Ld = () => ${SAFE_SCRIPT};`,
      ),
    },
    {
      name: "a type-only import of the serializer",
      source: lines(
        'import type { serializeJsonLd } from "@/lib/seo/json-ld";',
        `export const Ld = () => ${SAFE_SCRIPT};`,
      ),
    },
    {
      name: "text children",
      source: lines(
        'export const Ld = () => <script type="application/ld+json">{JSON.stringify(data)}</script>;',
      ),
    },
    {
      name: "markup held in a variable",
      source: lines(
        SHARED_IMPORT,
        "const html = { __html: serializeJsonLd(data) };",
        'export const Ld = () => <script type="application/ld+json" dangerouslySetInnerHTML={html} />;',
      ),
    },
    {
      name: "a spread that can replace the markup",
      source: lines(
        SHARED_IMPORT,
        'export const Ld = (props: object) => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} {...props} />;',
      ),
    },
    {
      name: "createElement",
      source: lines(
        'import { createElement } from "react";',
        SHARED_IMPORT,
        'export const Ld = () => createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: serializeJsonLd(data) } });',
      ),
    },
    {
      name: "an HTML string",
      source: lines(
        'export const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>`;',
      ),
    },
    {
      name: "the type held in a constant",
      source: lines(
        SHARED_IMPORT,
        'const TYPE = "application/ld+json";',
        "export const Ld = () => <script type={TYPE} dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;",
      ),
    },
  ])("refuses $name", ({ source }) => {
    expect(jsonLdOffences(PAGE, source)).toHaveLength(1);
  });

  it.each([
    {
      name: "the shared import",
      file: PAGE,
      source: lines(SHARED_IMPORT, `export const Ld = () => ${SAFE_SCRIPT};`),
    },
    {
      name: "the storefront re-export under another name",
      file: PAGE,
      source: lines(
        'import { serializeJsonLd as toJsonLd } from "@/app/(storefront)/components/json-ld";',
        'export const Ld = () => <script type={"application/ld+json"} dangerouslySetInnerHTML={{ __html: toJsonLd(data) }} />;',
      ),
    },
    {
      name: "a relative import",
      file: "app/help/layout.tsx",
      source: lines(
        'import { serializeJsonLd } from "../../lib/seo/json-ld";',
        `export const Ld = () => ${SAFE_SCRIPT};`,
      ),
    },
  ])("accepts $name", ({ file, source }) => {
    expect(jsonLdOffences(file, source)).toEqual([]);
  });
});
