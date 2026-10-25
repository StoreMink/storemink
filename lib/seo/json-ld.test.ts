import { describe, expect, it } from "vitest";
import { serializeJsonLd as storefrontSerializer } from "@/app/(storefront)/components/json-ld";
import { serializeJsonLd } from "./json-ld";

// The escape is written through character codes, never as a typed backslash
// sequence, so what this file asserts is exactly what the serializer emits.
const BACKSLASH = String.fromCharCode(92);
const escaped = (ch: string) =>
  BACKSLASH + "u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe("serializeJsonLd", () => {
  it("writes each character an HTML parser acts on as a JSON escape", () => {
    for (const ch of ["<", ">", "&", LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
      expect(serializeJsonLd({ name: `a${ch}b` })).toBe(
        `{"name":"a${escaped(ch)}b"}`,
      );
    }
  });

  // ★ The themes catalogue lists theme names a Theme Studio release carries,
  // and a release name is any text up to 100 characters.
  it("reads back as the same data when a theme name tries to close the script", () => {
    const data = {
      "@type": "CollectionPage",
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          { name: "Basket</script><script>alert(document.cookie)</script>" },
          {
            name: `Tea & toast <!--<script> ${LINE_SEPARATOR}x${PARAGRAPH_SEPARATOR}`,
          },
        ],
      },
    };
    const text = serializeJsonLd(data);

    expect(text).not.toMatch(/[<>&]/);
    expect(text).not.toContain(LINE_SEPARATOR);
    expect(text).not.toContain(PARAGRAPH_SEPARATOR);
    expect(JSON.parse(text)).toEqual(data);
  });

  it("leaves every other character as JSON.stringify wrote it", () => {
    const data = [
      { name: 'Chai "masala", 50% off', price: 199.5, inStock: true },
      { name: "हिंदी चाय ☕", note: "C:" + BACKSLASH + "path", tags: [] },
    ];

    expect(serializeJsonLd(data)).toBe(JSON.stringify(data));
  });

  it("is the function the storefront module still exports", () => {
    expect(storefrontSerializer).toBe(serializeJsonLd);
  });
});
