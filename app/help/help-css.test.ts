import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(__dirname, "help.css"), "utf8");

/** Every declaration block whose selector list is exactly `selector`. */
function blocksFor(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "g");
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(pattern)].map(
    (match) => match[1],
  );
}

describe("Help Centre stylesheet", () => {
  // The suggestions list hangs below the search box and past the hero's
  // bottom edge. `overflow: hidden` on the hero cut it off after its first
  // result (31 Oct 2026).
  it("never clips the hero, so the search suggestions can hang past it", () => {
    const hero = blocksFor(".hc-hero");
    expect(hero.length).toBeGreaterThan(0);
    for (const block of hero) {
      expect(block).not.toMatch(/overflow(?:-[xy])?\s*:\s*(?:hidden|clip)/);
    }
  });

  it("keeps the suggestions list out of the page flow", () => {
    const [suggest] = blocksFor(".hc-suggest");
    expect(suggest).toMatch(/position\s*:\s*absolute/);
  });
});
