// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ★ The forms are replaced by a probe that shows the Refine scope their boxes
//   would start a refine in: the scope is all this file is about.
vi.mock("./section-form", async () => {
  const { useImageRefineScope } =
    await import("@/components/ui/image-refine-context");
  const Probe = () => (
    <output data-testid="refine-scope">{useImageRefineScope()}</output>
  );
  return { SectionForm: Probe, fieldClass: "", labelClass: "" };
});
vi.mock("./chrome-form", async () => {
  const { useImageRefineScope } =
    await import("@/components/ui/image-refine-context");
  const Probe = () => (
    <output data-testid="refine-scope">{useImageRefineScope()}</output>
  );
  return { HeaderForm: Probe, FooterForm: Probe, BrandForm: Probe };
});

import { InspectorPanel } from "./inspector-panel";
import { builderRefineStillWanted } from "./image-refine-sweep";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { schemeDesignFor } from "@/lib/themes/schemes";
import type { PageDraft } from "@/app/actions/page-actions";
import type { PageSectionItem } from "@/lib/sections/registry";

const PAGE = "11111111-1111-4111-8111-111111111111";
const OTHER_PAGE = "22222222-2222-4222-8222-222222222222";
const PHOTO = "https://storage.googleapis.com/b/stores/s/uploads/hero.jpg";

const section = {
  id: "hero-1",
  type: "hero",
  enabled: true,
  config: { heading: "Hello", image: PHOTO },
} as unknown as PageSectionItem;
const draft = {
  id: PAGE,
  slug: "",
  title: "Home",
  status: "draft",
  updated_at: "2026-10-26",
  sections: [section],
} as unknown as PageDraft;
const brand = { name: "Test store", primaryColor: "#4f46e5", logoUrl: PHOTO };

function renderPanel(chromeTarget: "header" | "footer" | "brand" | null) {
  render(
    <InspectorPanel
      draft={draft}
      section={section}
      options={{ products: [], categories: [], blogs: [] }}
      onConfigChange={vi.fn()}
      onStyleChange={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      onClearSelection={vi.fn()}
      onOpenCodeEditor={vi.fn()}
      onOpenPageSettings={vi.fn()}
      chromeTarget={chromeTarget}
      chrome={DEFAULT_CHROME}
      onChromeChange={vi.fn()}
      onClearChrome={vi.fn()}
      brand={brand}
      themeDefaults={themeDesignDefaults(null)}
      schemeDesign={schemeDesignFor(null)}
      onBrandChange={vi.fn()}
      loading={false}
    />,
  );
  return screen.getByTestId("refine-scope").textContent ?? "";
}

describe("★★ InspectorPanel: refine scopes the builder's sweep can read", () => {
  // A scope the sweep cannot read is released at the next edit, which would
  // stop every builder refine (image-refine-sweep.ts).
  it("★★ a section's Content tab: kept while the section holds the photo, on this page and on another listed one", () => {
    const scope = renderPanel(null);
    const state = {
      draftId: PAGE,
      sections: [section],
      pageIds: [PAGE, OTHER_PAGE],
      chrome: DEFAULT_CHROME,
      brand,
    };
    const refine = { scope, sourceUrl: PHOTO };
    expect(builderRefineStillWanted(refine, state)).toBe(true);
    // Another page open, this one still listed: kept.
    expect(
      builderRefineStillWanted(refine, {
        ...state,
        draftId: OTHER_PAGE,
        sections: [],
      }),
    ).toBe(true);
    // This page deleted: released.
    expect(
      builderRefineStillWanted(refine, {
        ...state,
        draftId: OTHER_PAGE,
        sections: [],
        pageIds: [OTHER_PAGE],
      }),
    ).toBe(false);
  });

  it("★ the header, footer and brand forms: kept while the chrome or brand holds the photo", () => {
    for (const target of ["header", "footer", "brand"] as const) {
      const scope = renderPanel(target);
      expect(
        builderRefineStillWanted(
          { scope, sourceUrl: PHOTO },
          {
            draftId: PAGE,
            sections: [],
            pageIds: [PAGE],
            chrome: DEFAULT_CHROME,
            brand,
          },
        ),
        target,
      ).toBe(true);
      cleanup();
    }
  });
});
