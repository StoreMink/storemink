import { describe, expect, it } from "vitest";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  BUILDER_CHROME_REFINE_SCOPE,
  builderRefineStillWanted,
  builderSectionRefineScope,
  type BuilderRefineState,
} from "./image-refine-sweep";

const PHOTO = "https://storage.googleapis.com/b/stores/s/uploads/hero.jpg";
const OTHER_PHOTO = "https://storage.googleapis.com/b/stores/s/uploads/x.jpg";
const PAGE = "11111111-1111-4111-8111-111111111111";
const OTHER_PAGE = "22222222-2222-4222-8222-222222222222";

function section(id: string, config: Record<string, unknown>): PageSectionItem {
  return {
    id,
    type: "hero",
    enabled: true,
    config,
  } as unknown as PageSectionItem;
}

function state(
  overrides: Partial<BuilderRefineState> = {},
): BuilderRefineState {
  return {
    draftId: PAGE,
    sections: [
      section("hero-1", { image: PHOTO }),
      section("gallery-1", {
        images: [{ url: OTHER_PHOTO, alt: "" }],
      }),
    ],
    pageIds: [PAGE, OTHER_PAGE],
    chrome: { header: { menu: [{ label: "Shop", image: OTHER_PHOTO }] } },
    brand: { logoUrl: null },
    ...overrides,
  };
}

const wanted = (scope: string, sourceUrl = PHOTO, s = state()) =>
  builderRefineStillWanted({ scope, sourceUrl }, s);

describe("★★ builderRefineStillWanted: a refine goes only when its slot is destroyed", () => {
  it("keeps every refine outside the builder", () => {
    expect(wanted("route:/dashboard/products/1")).toBe(true);
    expect(wanted("product:abc")).toBe(true);
    expect(wanted("category:new", "https://example.test/gone.jpg")).toBe(true);
  });

  it("★ on the open page: kept while the section exists and still holds the photo", () => {
    expect(wanted(`builder:${PAGE}:hero-1`)).toBe(true);
    // A nested field (a gallery image) counts too.
    expect(wanted(`builder:${PAGE}:gallery-1`, OTHER_PHOTO)).toBe(true);
  });

  it("★★ on the open page: released when the section is deleted", () => {
    expect(
      wanted(
        `builder:${PAGE}:hero-1`,
        PHOTO,
        state({ sections: [section("gallery-1", { images: [] })] }),
      ),
    ).toBe(false);
  });

  it("★★ on the open page: released when the photo leaves the section (removed, replaced, undone)", () => {
    const removed = state({ sections: [section("hero-1", { image: "" })] });
    expect(wanted(`builder:${PAGE}:hero-1`, PHOTO, removed)).toBe(false);
    const replaced = state({
      sections: [section("hero-1", { image: OTHER_PHOTO })],
    });
    expect(wanted(`builder:${PAGE}:hero-1`, PHOTO, replaced)).toBe(false);
    // A gallery image removed from its list.
    expect(
      wanted(
        `builder:${PAGE}:gallery-1`,
        OTHER_PHOTO,
        state({ sections: [section("gallery-1", { images: [] })] }),
      ),
    ).toBe(false);
  });

  it("★ finds a URL however JSON writes it", () => {
    const quoted = 'https://storage.googleapis.com/b/stores/s/uploads/a"b.jpg';
    const s = state({ sections: [section("hero-1", { image: quoted })] });
    expect(wanted(`builder:${PAGE}:hero-1`, quoted, s)).toBe(true);
  });

  it("★★ another page is kept while the builder still lists it, whatever the open draft holds", () => {
    // Even a section of the open page with the same id and no such photo.
    const s = state({ sections: [section("hero-1", { image: "" })] });
    expect(wanted(`builder:${OTHER_PAGE}:hero-1`, PHOTO, s)).toBe(true);
    // Deleting that page releases it.
    expect(
      wanted(`builder:${OTHER_PAGE}:hero-1`, PHOTO, state({ pageIds: [PAGE] })),
    ).toBe(false);
  });

  it("★ with no open page (it was just deleted), refines on listed pages are kept and its own go", () => {
    const s = state({ draftId: null, sections: [], pageIds: [OTHER_PAGE] });
    expect(wanted(`builder:${OTHER_PAGE}:hero-1`, PHOTO, s)).toBe(true);
    expect(wanted(`builder:${PAGE}:hero-1`, PHOTO, s)).toBe(false);
  });

  it("★ switching back makes the open-page checks apply again", () => {
    const back = state({
      draftId: OTHER_PAGE,
      sections: [section("hero-1", { image: PHOTO })],
    });
    expect(wanted(`builder:${OTHER_PAGE}:hero-1`, PHOTO, back)).toBe(true);
    const storedWithout = state({
      draftId: OTHER_PAGE,
      sections: [section("hero-1", { image: OTHER_PHOTO })],
    });
    expect(wanted(`builder:${OTHER_PAGE}:hero-1`, PHOTO, storedWithout)).toBe(
      false,
    );
  });

  it("★ the chrome scope is kept while the header, footer or brand holds the photo", () => {
    expect(wanted("builder:chrome", OTHER_PHOTO)).toBe(true);
    expect(
      wanted(
        "builder:chrome",
        OTHER_PHOTO,
        state({ chrome: { header: { menu: [{ label: "Shop", image: "" }] } } }),
      ),
    ).toBe(false);
    expect(
      wanted(
        "builder:chrome",
        PHOTO,
        state({ brand: { logoUrl: null, heroTile: PHOTO } }),
      ),
    ).toBe(true);
  });

  it("releases a builder scope it cannot read (fails safe: a stop charges nothing)", () => {
    expect(wanted("builder:not-a-scope")).toBe(false);
  });

  it("★★ reads every scope the inspector builds, whatever the section id holds", () => {
    expect(BUILDER_CHROME_REFINE_SCOPE).toBe("builder:chrome");
    for (const sectionId of ["hero-1", "hero:2", "a:b:c"]) {
      const s = state({
        sections: [section(sectionId, { image: PHOTO })],
      });
      const scope = builderSectionRefineScope(PAGE, sectionId);
      expect(wanted(scope, PHOTO, s), scope).toBe(true);
      // The same section on another page that is still listed: kept.
      expect(
        wanted(builderSectionRefineScope(OTHER_PAGE, sectionId), PHOTO, s),
      ).toBe(true);
      // Its photo gone: released.
      expect(
        wanted(
          scope,
          PHOTO,
          state({ sections: [section(sectionId, { image: "" })] }),
        ),
      ).toBe(false);
    }
  });
});
