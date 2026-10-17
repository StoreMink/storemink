// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeMinkPrefill, takeMinkPrefill } from "@/lib/mink/form-prefill";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard/blogs",
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/blog-actions", () => ({
  createBlog: vi.fn(),
  updateBlog: vi.fn(),
  autosaveBlog: vi.fn(),
  deleteBlog: vi.fn(),
  publishBlog: vi.fn(),
  unpublishBlog: vi.fn(),
  approveCustomerBlog: vi.fn(),
  rejectCustomerBlog: vi.fn(),
  bulkSetBlogStatus: vi.fn(),
  bulkSetBlogFeatured: vi.fn(),
  bulkDeleteBlogs: vi.fn(),
  getBlogForEditor: vi.fn(),
}));
vi.mock("@/app/dashboard/components/import-export-menu", () => ({
  ImportExportMenu: () => null,
}));
vi.mock("@/app/dashboard/components/list-pagination", () => ({
  ListPagination: () => null,
}));
vi.mock("@/app/dashboard/components/bulk-actions", () => ({
  BulkActionBar: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  RowCheckbox: () => <input type="checkbox" aria-label="row checkbox" />,
  SelectAllCheckbox: () => <input type="checkbox" aria-label="select all" />,
}));
// The view loads the editor lazily; the stub reports what it was handed.
vi.mock("next/dynamic", () => ({
  default: () =>
    function BlogEditorStub({
      open,
      blog,
      prefill,
    }: {
      open: boolean;
      blog: unknown;
      prefill?: { title?: string } | null;
    }) {
      return (
        <div data-testid="blog-editor">
          {open
            ? `open:${blog ? "edit" : "new"}:${prefill?.title ?? "-"}`
            : "closed"}
        </div>
      );
    },
}));
// The real dialog, with TipTap replaced by a stub editor whose
// `setContent` records the HTML the prefill produced.
const editorStub = {
  isActive: vi.fn(() => false),
  chain: vi.fn(() => ({ focus: () => ({ run: () => undefined }) })),
  getHTML: vi.fn(() => ""),
  commands: { setContent: vi.fn(), clearContent: vi.fn() },
};
vi.mock("@tiptap/react", () => ({
  useEditor: () => editorStub,
  EditorContent: () => <div data-testid="editor-content" />,
}));
vi.mock("./media-picker-dialog", () => ({
  MediaPickerDialog: () => null,
  normalizeBlogCoverMediaUrl: () => null,
}));
vi.mock("@/hooks/use-unsaved-changes-warning", () => ({
  useUnsavedChangesWarning: () => undefined,
}));

import { BlogsManagementView } from "./blogs-management-view";
import { BlogEditorDialog, blogPrefillFields } from "./blog-editor-dialog";

const NOTICE = "Filled in by Mink AI. Review every field before saving.";

const viewProps = {
  blogs: [],
  canManage: true,
  counts: { all: 0, published: 0, drafts: 0, featured: 0, pending: 0 },
  total: 0,
  page: 1,
  pageSize: 20,
  query: "",
  filter: "all" as const,
  categoryOptions: ["Recipes"],
  tagOptions: ["oats"],
  mediaUrlPrefix: "",
};

const PREFILL = {
  title: "Why oat milk froths",
  excerpt: "A short guide to a creamy pour.",
  body: "# The science\n\nProteins hold the bubbles.\n\n- shake first\n- pour slowly",
  category: "recipes",
  tags: ["Oats", "coffee"],
  seoTitle: "Oat milk froth guide",
  seoDescription: "How to froth oat milk at home.",
};

describe("BlogsManagementView with a Mink prefill", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/dashboard/blogs");
  });

  it("opens the editor as a new post carrying the prefill", () => {
    storeMinkPrefill({ kind: "blog", fields: PREFILL });
    window.history.replaceState(null, "", "?prefill=mink");
    render(<BlogsManagementView {...viewProps} />);
    expect(screen.getByTestId("blog-editor")).toHaveTextContent(
      "open:new:Why oat milk froths",
    );
    expect(takeMinkPrefill("blog")).toBeNull();
    expect(window.location.search).not.toContain("prefill");
  });

  it("leaves the editor closed without the flag", () => {
    storeMinkPrefill({ kind: "blog", fields: { title: "Stale" } });
    render(<BlogsManagementView {...viewProps} />);
    expect(screen.queryByTestId("blog-editor")).toBeNull();
    expect(takeMinkPrefill("blog")).toEqual({ title: "Stale" });
  });
});

describe("BlogEditorDialog with a Mink prefill", () => {
  beforeEach(() => {
    editorStub.commands.setContent.mockClear();
  });

  const dialog = (prefill: typeof PREFILL | null) => (
    <BlogEditorDialog
      open
      blog={null}
      prefill={prefill}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      categoryOptions={["Recipes"]}
      tagOptions={["oats"]}
      mediaUrlPrefix=""
    />
  );

  it("fills the fields, the body as HTML, and says so", async () => {
    render(dialog(PREFILL));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(
      await screen.findByDisplayValue("Why oat milk froths"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("A short guide to a creamy pour."),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Oat milk froth guide"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("How to froth oat milk at home."),
    ).toBeInTheDocument();
    expect(editorStub.commands.setContent).toHaveBeenCalledWith(
      "<h2>The science</h2><p>Proteins hold the bubbles.</p><ul><li>shake first</li><li>pour slowly</li></ul>",
    );
    // Filled, not saved.
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Blog" })).toBeEnabled();
  });

  it("opens blank without a prefill", async () => {
    render(dialog(null));
    expect(await screen.findByText("New Blog")).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(editorStub.commands.setContent).not.toHaveBeenCalled();
    expect(screen.getByText(/All changes saved/)).toBeInTheDocument();
  });

  it("matches a category or tag to the store's list and drops the rest", () => {
    const fields = blogPrefillFields(PREFILL, ["Recipes"], ["oats"]);
    expect(fields.categories).toEqual(["Recipes"]);
    expect(fields.tags).toEqual(["oats"]);
    expect(fields.slug).toBe("why-oat-milk-froths");
    // No list yet: Mink's own names are kept.
    expect(blogPrefillFields(PREFILL, [], []).categories).toEqual(["recipes"]);
    expect(blogPrefillFields(PREFILL, [], []).tags).toEqual(["Oats", "coffee"]);
  });
});
