// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TickerSection } from "./ticker-section";

// ★★ WITH MOTION OFF, EACH MESSAGE SHOWS ONCE (23 Nov 2026). The band's
// sequence holds the messages several times over to fill the loop. Standing
// still and wrapped (prefers-reduced-motion), it showed every copy: on
// Aurelle's catalogue picture, taken with motion off, three messages were a
// block of twelve lines. jsdom lays nothing out, so these pin the two halves
// separately: the markup marks the copies, and the stylesheet drops them.

const MESSAGES = [
  "Complimentary express shipping across India",
  "New season: the autumn capsule now live",
  "Crafted from combed cotton",
];

function renderTicker(messages: string[]) {
  return render(
    <TickerSection
      sectionId="t"
      config={{ messages, speed: "medium", theme: "light" }}
    />,
  ).container;
}

describe("ticker", () => {
  it("fills the loop with copies, two sequences, the second hidden from readers", () => {
    const seqs = renderTicker(MESSAGES).querySelectorAll(".home-ticker-seq");
    expect(seqs).toHaveLength(2);
    expect(seqs[1].getAttribute("aria-hidden")).toBe("true");
    // Three messages, four times over.
    expect(seqs[0].querySelectorAll(".home-ticker-item")).toHaveLength(12);
    // The two sequences are the same length, or the -50% loop would jump.
    expect(seqs[1].children).toHaveLength(seqs[0].children.length);
  });

  it("★★ only the first run of the messages is unmarked; every copy is `is-repeat` and silent", () => {
    const first =
      renderTicker(MESSAGES).querySelectorAll(".home-ticker-seq")[0];
    const originals = first.querySelectorAll(
      ".home-ticker-item:not(.is-repeat)",
    );
    expect(Array.from(originals, (item) => item.textContent)).toEqual(MESSAGES);
    expect(Array.from(first.children).slice(0, 3)).toEqual(
      Array.from(originals),
    );
    for (const original of originals) {
      expect(original.getAttribute("aria-hidden")).toBeNull();
    }
    const copies = first.querySelectorAll(".home-ticker-item.is-repeat");
    expect(copies).toHaveLength(9);
    for (const copy of copies) {
      expect(copy.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("★ marks the last message, once, so no separator trails it when the band stands still", () => {
    for (const messages of [MESSAGES, ["Only one"]]) {
      const first =
        renderTicker(messages).querySelectorAll(".home-ticker-seq")[0];
      const last = first.querySelectorAll(".home-ticker-item.is-last");
      expect(last).toHaveLength(1);
      expect(last[0].textContent).toBe(messages[messages.length - 1]);
      expect(last[0].classList.contains("is-repeat")).toBe(false);
    }
  });

  it("renders nothing without a message", () => {
    expect(renderTicker([]).firstChild).toBeNull();
  });
});

describe("the stylesheet, with motion off", () => {
  const css = readFileSync(
    join(process.cwd(), "app/(storefront)/components/homepage/homepage.css"),
    "utf8",
  );
  /** The body of every `prefers-reduced-motion: reduce` block that names `needle`. */
  function reducedMotionBlocks(needle: string): string {
    const out: string[] = [];
    const opener = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
    for (let m = opener.exec(css); m; m = opener.exec(css)) {
      let depth = 1;
      let i = opener.lastIndex;
      while (depth > 0 && i < css.length) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") depth -= 1;
        i += 1;
      }
      const body = css.slice(opener.lastIndex, i - 1);
      if (body.includes(needle)) out.push(body);
    }
    return out.join("\n");
  }
  /** The declarations of the rule whose selector list includes `selector`. */
  function declarationsFor(block: string, selector: string): string {
    const rules = block.matchAll(/([^{}]+)\{([^{}]*)\}/g);
    for (const [, selectors, body] of rules) {
      const list = selectors
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map((s) => s.trim());
      if (list.includes(selector)) return body;
    }
    return "";
  }

  it("★★ drops the ticker's copies and its second sequence, and the trailing separator", () => {
    const block = reducedMotionBlocks(".home-ticker-track");
    expect(declarationsFor(block, ".home-ticker-item.is-repeat")).toMatch(
      /display:\s*none/,
    );
    expect(
      declarationsFor(block, '.home-ticker-seq[aria-hidden="true"]'),
    ).toMatch(/display:\s*none/);
    expect(declarationsFor(block, ".home-ticker-item.is-last::after")).toMatch(
      /display:\s*none/,
    );
    expect(declarationsFor(block, ".home-ticker-track")).toMatch(
      /animation:\s*none/,
    );
  });

  it("★★ drops the picture marquee's copies and its second sequence", () => {
    const block = reducedMotionBlocks(".home-marquee-track");
    expect(declarationsFor(block, ".home-marquee-item.is-repeat")).toMatch(
      /display:\s*none/,
    );
    expect(
      declarationsFor(
        block,
        ".home-marquee-track .home-marquee-seq[aria-hidden]",
      ),
    ).toMatch(/display:\s*none/);
  });

  it("never hides a copy while the band is moving: the loop needs them", () => {
    // The stylesheet without its comments and without every motion-off block.
    let moving = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const opener = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/;
    for (let m = opener.exec(moving); m; m = opener.exec(moving)) {
      let depth = 1;
      let end = m.index + m[0].length;
      while (depth > 0 && end < moving.length) {
        if (moving[end] === "{") depth += 1;
        else if (moving[end] === "}") depth -= 1;
        end += 1;
      }
      moving = moving.slice(0, m.index) + moving.slice(end);
    }
    expect(moving).toContain(".home-ticker-item");
    expect(moving).not.toContain(".is-repeat");
  });
});
