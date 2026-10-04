// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderClient } from "./builder-client";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { schemeDesignFor } from "@/lib/themes/schemes";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";

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
    updated_at: "2026-10-04",
    sections: [
      {
        id: "hero",
        type: "hero",
        enabled: true,
        config: { heading: "Original heading" },
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
    onSelectChrome,
  }: {
    onSelectSection: (id: string) => void;
    onSelectChrome: (area: string) => void;
  }) => (
    <aside data-testid="outline">
      <button onClick={() => onSelectSection("hero")}>Choose hero</button>
      <button onClick={() => onSelectChrome("header")}>Choose header</button>
    </aside>
  ),
}));
vi.mock("./inspector-panel", () => ({
  InspectorPanel: ({
    section,
    chromeTarget,
    onConfigChange,
    onClearSelection,
    onClearChrome,
  }: {
    section?: { config: typeof EMPTY_CONFIG.hero };
    chromeTarget?: string;
    onConfigChange: (config: typeof EMPTY_CONFIG.hero) => void;
    onClearSelection: () => void;
    onClearChrome: () => void;
  }) => (
    <aside>
      {section && (
        <input
          aria-label="Headline"
          value={section.config.heading}
          onChange={(e) =>
            onConfigChange({ ...section.config, heading: e.target.value })
          }
        />
      )}
      <span>{chromeTarget}</span>
      <button onClick={chromeTarget ? onClearChrome : onClearSelection}>
        Back to outline
      </button>
    </aside>
  ),
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
      updated_at: "2026-10-04",
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

describe("Builder mobile panels", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the draft and iframe mounted across phone panels and preserves undo", async () => {
    const { container } = render(<BuilderClient {...props} />);
    await waitFor(() =>
      expect(screen.getByText("Choose hero")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Choose hero"));
    await screen.findByLabelText("Headline");
    expect(container.querySelector(".sm-builder")).toHaveAttribute(
      "data-mobile-view",
      "edit",
    );
    const frame = container.querySelector("iframe");
    fireEvent.change(screen.getByLabelText("Headline"), {
      target: { value: "Edited on a phone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(container.querySelector(".sm-builder")).toHaveAttribute(
      "data-mobile-view",
      "preview",
    );
    expect(container.querySelector("iframe")).toBe(frame);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Headline")).toHaveValue("Edited on a phone");
    fireEvent.click(screen.getByTitle("Undo (⌘Z)"));
    expect(screen.getByLabelText("Headline")).toHaveValue("Original heading");
  });
  it("keeps the outline available after a desktop collapse", async () => {
    localStorage.setItem("sm-builder-left-collapsed", "1");
    const { container } = render(<BuilderClient {...props} />);
    await screen.findByText("Choose hero");
    expect(container.querySelector(".sm-builder")).toHaveClass(
      "is-left-collapsed",
    );
    expect(screen.getByTestId("outline")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Pages & sections" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByText("Choose header"));
    expect(container.querySelector(".sm-builder")).toHaveAttribute(
      "data-mobile-view",
      "edit",
    );
    fireEvent.click(screen.getByText("Back to outline"));
    expect(container.querySelector(".sm-builder")).toHaveAttribute(
      "data-mobile-view",
      "outline",
    );
  });
});
