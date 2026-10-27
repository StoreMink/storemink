import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canOptimizeImage } from "./image-hosts";

describe("canOptimizeImage", () => {
  it("optimises our bucket, Unsplash and site paths", () => {
    expect(
      canOptimizeImage("https://storage.googleapis.com/b/stores/s/a.webp"),
    ).toBe(true);
    expect(canOptimizeImage("https://images.unsplash.com/photo-1")).toBe(true);
    expect(canOptimizeImage("/themes/basket/hero.webp")).toBe(true);
  });

  // ★ next/image throws on an unconfigured host, which took the Product
  //   images tab down for a store with photos on an older external host.
  it("leaves any other host to a plain image request", () => {
    expect(canOptimizeImage("https://cdn.example.com/x.png")).toBe(false);
    expect(canOptimizeImage("http://storage.googleapis.com/b/a.webp")).toBe(
      false,
    );
    expect(canOptimizeImage("//evil.example/a.png")).toBe(false);
    expect(canOptimizeImage("not a url")).toBe(false);
    expect(canOptimizeImage("")).toBe(false);
  });

  it("names exactly the hosts next.config.ts allows", () => {
    const config = readFileSync("next.config.ts", "utf8");
    const hosts = [...config.matchAll(/hostname:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(canOptimizeImage(`https://${host}/x.png`), host).toBe(true);
    }
    expect(canOptimizeImage("https://example.com/x.png")).toBe(false);
  });
});
