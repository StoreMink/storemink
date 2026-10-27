// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderClient } from "./builder-client";
import { builderSectionRefineScope } from "./image-refine-sweep";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { schemeDesignFor } from "@/lib/themes/schemes";
import { sendPageExitRequest } from "@/lib/http/page-exit-request";
import {
  resetImageRefinesForTests,
  startImageRefine,
} from "@/components/ui/image-refine-registry";

const PHOTO = "https://storage.googleapis.com/b/stores/s/uploads/hero.jpg";

vi.mock("@/lib/http/page-exit-request", () => ({
  sendPageExitRequest: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/app/actions/page-actions", () => ({
  getPageDraft: vi.fn(async () => ({
    id: "home",
    slug: "",
    title: "Home",
    status: "draft",
    updated_at: "2026-10-26",
    sections: [
      {
        id: "hero",
        type: "hero",
        enabled: true,
        config: {
          heading: "Original heading",
          image: "https://storage.googleapis.com/b/stores/s/uploads/hero.jpg",
        },
      },
    ],
  })),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  publishPage: vi.fn(),
  unpublishPage: vi.fn(),
  updatePageMeta: vi.fn(),
}));
vi.mock("@/app/actions/chrome-actions", () => ({
  saveChromeDraft: vi.fn(),
  publishChrome: vi.fn(),
}));
vi.mock("@/app/actions/store-branding", () => ({
  saveBrandAppearance: vi.fn(),
}));
vi.mock("./use-autosave", () => ({
  useAutosave: () => ({
    status: "saved",
    markDirty: vi.fn(),
    flush: vi.fn(),
    unblock: vi.fn(),
  }),
}));
vi.mock("./outline-panel", () => ({
  OutlinePanel: ({
    onSelectSection,
  }: {
    onSelectSection: (id: string) => void;
  }) => <button onClick={() => onSelectSection("hero")}>Choose hero</button>,
}));
vi.mock("./inspector-panel", () => ({
  InspectorPanel: ({
    section,
    onConfigChange,
  }: {
    section?: { config: Record<string, unknown> };
    onConfigChange: (config: Record<string, unknown>) => void;
  }) =>
    section ? (
      <aside>
        <button
          onClick={() =>
            onConfigChange({ ...section.config, heading: "New heading" })
          }
        >
          Edit heading
        </button>
        <button
          onClick={() => onConfigChange({ ...section.config, image: "" })}
        >
          Remove image
        </button>
      </aside>
    ) : null,
  PageSettingsForm: () => null,
}));
vi.mock("./section-library", () => ({ SectionLibrary: () => null }));

const props = {
  initialPages: [
    {
      id: "home",
      slug: "",
      title: "Home",
      status: "draft" as const,
      updated_at: "2026-10-26",
      published_at: null,
    },
  ],
  products: [],
  categories: [],
  blogs: [],
  storeName: "Test store",
  initialChrome: DEFAULT_CHROME,
  initialBrand: { name: "Test store", primaryColor: "#4f46e5", logoUrl: null },
  themeDefaults: themeDesignDefaults(null),
  schemeDesign: schemeDesignFor(null),
};

let tokens: string[];

beforeEach(() => {
  localStorage.clear();
  tokens = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === "/api/mink/image-refine") {
        tokens.push(
          (JSON.parse(String(init.body)) as { stopToken: string }).stopToken,
        );
        // Still refining: it never answers here.
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
});

afterEach(() => {
  resetImageRefinesForTests();
  vi.unstubAllGlobals();
});

describe("★★ BuilderClient: a refine goes only when its slot is destroyed", () => {
  it("★★ an edit that keeps the photo stops nothing; removing the photo stops its refine", async () => {
    render(<BuilderClient {...props} />);
    fireEvent.click(await screen.findByText("Choose hero"));
    await screen.findByText("Remove image");
    startImageRefine({
      scope: builderSectionRefineScope("home", "hero"),
      pathname: "/dashboard/builder",
      spec: "hero_wide",
      sourceUrl: PHOTO,
    });

    fireEvent.click(screen.getByText("Edit heading"));
    expect(sendPageExitRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Remove image"));
    await waitFor(() =>
      expect(sendPageExitRequest).toHaveBeenCalledWith(
        "/api/mink/image-refine/stop",
        JSON.stringify({ stopToken: tokens[0] }),
      ),
    );
    expect(sendPageExitRequest).toHaveBeenCalledOnce();
  });
});
