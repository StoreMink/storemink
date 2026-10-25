// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StoreBrand } from "@/lib/store/brand";
import { JsonLd } from "./json-ld";
import StructuredData from "./structured-data";

// ★ Every JSON-LD writer puts text someone typed (a store blurb, a product
// description, a blog title, a Mink revamp's copy) inside a <script> element,
// and an HTML parser ends that element at the first "</script" whatever JSON
// thinks is a string. So these tests do not read the markup as a string: they
// parse it the way a browser does and count the elements it builds.

const store = vi.hoisted(() => ({ brand: null as StoreBrand | null }));

vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => store.brand),
}));
vi.mock("@/lib/site", () => ({
  getStoreUrl: vi.fn(async () => "https://asha.example"),
}));

const BREAKOUT =
  "Fresh bread daily.</script><img src=x onerror=alert(1)><script>alert(document.cookie)</script>";
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function parse(markup: string): Document {
  return new DOMParser().parseFromString(markup, "text/html");
}

// The one element the markup may build, or a failure naming what else it made.
function onlyScript(doc: Document): HTMLScriptElement {
  const elements = [...doc.querySelectorAll("head *, body *")];
  expect(elements.map((element) => element.tagName.toLowerCase())).toEqual([
    "script",
  ]);
  return elements[0] as HTMLScriptElement;
}

function between(markup: string): string {
  return markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("</script>"));
}

function brand(overrides: Partial<StoreBrand>): StoreBrand {
  return {
    name: "Asha Bakes",
    logoUrl: null,
    primaryColor: "#17130f",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain: "storemink.com",
    ...overrides,
  };
}

describe("JsonLd", () => {
  it("keeps a closing script tag in the text from ending the element", () => {
    const data = {
      "@type": "Product",
      name: "Sourdough",
      description: BREAKOUT,
    };
    const markup = renderToStaticMarkup(<JsonLd data={data} />);

    const script = onlyScript(parse(markup));
    expect(script.type).toBe("application/ld+json");
    expect(JSON.parse(script.text)).toEqual(data);
  });

  it("keeps a comment opener in the text from swallowing the page after it", () => {
    // "<!--<script>" puts the tokenizer in its double-escaped state, where the
    // element's own "</script>" no longer ends it: the rest of the page would
    // become JSON-LD text.
    const data = { "@type": "Product", name: "Rye <!--<script> loaf" };
    const markup = renderToStaticMarkup(
      <div>
        <JsonLd data={data} />
        <p id="after">Add to cart</p>
      </div>,
    );

    const doc = parse(markup);
    expect(doc.getElementById("after")?.textContent).toBe("Add to cart");
    expect(JSON.parse(doc.querySelector("script")?.text ?? "")).toEqual(data);
  });

  it("leaves no markup character or line separator bare, and loses nothing", () => {
    const data = {
      name: `Tea & toast <b>"special"</b> -> ${LINE_SEPARATOR}a${PARAGRAPH_SEPARATOR}b`,
    };
    const inner = between(renderToStaticMarkup(<JsonLd data={data} />));

    expect(inner).not.toMatch(/[<>&]/);
    expect(inner).not.toContain(LINE_SEPARATOR);
    expect(inner).not.toContain(PARAGRAPH_SEPARATOR);
    expect(JSON.parse(inner)).toEqual(data);
  });

  it("still emits one script holding a JSON array for several nodes", () => {
    const nodes = [
      { "@type": "Product", name: "Sourdough </script>" },
      { "@type": "BreadcrumbList", itemListElement: [] },
    ];
    const script = onlyScript(
      parse(renderToStaticMarkup(<JsonLd data={nodes} />)),
    );

    expect(JSON.parse(script.text)).toEqual(nodes);
  });
});

describe("StructuredData", () => {
  // ★ The homepage Organization node carries stores.settings.brand.blurb,
  // which a merchant edits in Branding and a revamp's Apply writes live.
  it("serializes a store blurb that closes the script element as text", async () => {
    store.brand = brand({ blurb: BREAKOUT });
    const markup = renderToStaticMarkup(await StructuredData());

    const script = onlyScript(parse(markup));
    const graph = JSON.parse(script.text) as {
      "@graph": { "@type": string; description?: string }[];
    };
    expect(graph["@graph"][0]).toMatchObject({
      "@type": "Organization",
      description: BREAKOUT,
    });
  });
});
