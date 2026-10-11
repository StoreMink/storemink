import { describe, expect, it } from "vitest";
import { normalizeAuthHost, storeAuthHosts } from "./store-auth-hosts";

const ROOT = "storemink.com";
const PREVIEW = {
  demo: true,
  studioPreview: {
    projectId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
  },
};

describe("storeAuthHosts", () => {
  it("★ lists the store's own exact subdomain", () => {
    // Phone sign-in needs the exact host; storemink.com alone is not enough.
    expect(storeAuthHosts({ slug: "echoss", settings: {} }, ROOT)).toEqual([
      "echoss.storemink.com",
    ]);
  });

  it("adds the apex and www of a VERIFIED custom domain", () => {
    expect(
      storeAuthHosts(
        {
          slug: "wholesip",
          custom_domain: "WholeSip.com",
          settings: { custom_domain_verified: true },
        },
        ROOT,
      ),
    ).toEqual(["wholesip.storemink.com", "wholesip.com", "www.wholesip.com"]);
    // Connected as www: the apex companion comes along too.
    expect(
      storeAuthHosts(
        {
          slug: "wholesip",
          custom_domain: "www.wholesip.com",
          settings: { custom_domain_verified: true },
        },
        ROOT,
      ),
    ).toEqual(["wholesip.storemink.com", "www.wholesip.com", "wholesip.com"]);
  });

  it("adds only the exact host for a custom subdomain (no www companion)", () => {
    expect(
      storeAuthHosts(
        {
          slug: "acme",
          custom_domain: "shop.acme.co.uk",
          settings: { custom_domain_verified: true },
        },
        ROOT,
      ),
    ).toEqual(["acme.storemink.com", "shop.acme.co.uk"]);
  });

  it("ignores an unverified custom domain", () => {
    for (const settings of [
      {},
      { custom_domain_verified: false },
      { custom_domain_verified: "true" },
      null,
    ]) {
      expect(
        storeAuthHosts(
          { slug: "acme", custom_domain: "acme.com", settings },
          ROOT,
        ),
      ).toEqual(["acme.storemink.com"]);
    }
  });

  it("returns nothing for a demo store or a Theme Studio preview store", () => {
    expect(
      storeAuthHosts({ slug: "demo-vitrine", settings: { demo: true } }, ROOT),
    ).toEqual([]);
    expect(
      storeAuthHosts(
        {
          slug: "studio-preview-abc",
          custom_domain: "x.com",
          settings: { ...PREVIEW, custom_domain_verified: true },
        },
        ROOT,
      ),
    ).toEqual([]);
  });

  it("returns nothing on a local development root", () => {
    for (const root of [
      "localhost",
      "localhost:3000",
      "dev.localhost",
      "localtest.me",
      "x.localtest.me",
    ]) {
      expect(storeAuthHosts({ slug: "echoss" }, root), root).toEqual([]);
    }
  });

  it("works on a non-production root and normalises it", () => {
    expect(
      storeAuthHosts({ slug: "Echoss" }, "https://Dev.StoreMink.com/"),
    ).toEqual(["echoss.dev.storemink.com"]);
  });

  it("drops what cannot be a host instead of listing junk", () => {
    expect(storeAuthHosts({ slug: "bad_slug" }, ROOT)).toEqual([]);
    expect(storeAuthHosts({ slug: "" }, ROOT)).toEqual([]);
    expect(storeAuthHosts({ slug: "echoss" }, "")).toEqual([]);
  });
});

describe("normalizeAuthHost (pure home)", () => {
  it("strips scheme, port, path and trailing dots", () => {
    expect(normalizeAuthHost("HTTP://Shop.Acme.com.:8080/x")).toBe(
      "shop.acme.com",
    );
  });
});
