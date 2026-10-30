// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeMinkPrefill, takeMinkPrefill } from "@/lib/mink/form-prefill";
import { ITEM, itemBlockedBanner } from "@/lib/moderation/copy";

const R = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => R,
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
      blockedByStoreMink,
      canSeeNotices,
    }: {
      open: boolean;
      blog: unknown;
      prefill?: { title?: string } | null;
      blockedByStoreMink?: string | null;
      canSeeNotices?: boolean;
    }) {
      return (
        <div data-testid="blog-editor">
          {open
            ? `open:${blog ? "edit" : "new"}:${prefill?.title ?? "-"}`
            : "closed"}
          {` blocked:${blockedByStoreMink ?? "-"} notices:${String(canSeeNotices)}`}
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
import { getBlogForEditor } from "@/app/actions/blog-actions";

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

// ── Blocked by StoreMink (takedown design 7.3) ──────────────

function post(id: string, over: Record<string, unknown> = {}): any {
  return {
    id,
    title: `Post ${id}`,
    slug: `post-${id}`,
    excerpt: null,
    content: null,
    cover_image_url: null,
    author: "Asha",
    status: "published",
    tags: [],
    categories: [],
    featured: false,
    seo_title: null,
    seo_description: null,
    reading_time: null,
    created_by: null,
    updated_by: null,
    published_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    submitted_by: null,
    is_customer_submission: false,
    ...over,
  };
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest("tr");
  if (!row) throw new Error(`no row for ${title}`);
  return row;
}

async function openMenu(title: string) {
  const user = userEvent.setup();
  await user.click(
    within(rowFor(title)).getByRole("button", { name: "Actions" }),
  );
  // The menu opens a beat after the click.
  await screen.findAllByRole("menuitem");
  return user;
}

describe("BlogsManagementView with a post StoreMink blocked", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/dashboard/blogs");
  });

  const blockedView = (over: Record<string, unknown> = {}) => (
    <BlogsManagementView
      {...viewProps}
      blogs={[post("a"), post("b")]}
      total={2}
      blockedByStoreMink={{ a: "block-a" }}
      canSeeNotices
      {...over}
    />
  );

  it("reads Blocked by StoreMink in place of the post's status", () => {
    render(blockedView());
    expect(within(rowFor("Post a")).getByText(ITEM.blocked)).toHaveClass(
      "dash-badge-storemink",
    );
    expect(within(rowFor("Post a")).queryByText("Published")).toBeNull();
    // ★ The other post is untouched.
    expect(within(rowFor("Post b")).getByText("Published")).toBeInTheDocument();
    expect(within(rowFor("Post b")).queryByText(ITEM.blocked)).toBeNull();
  });

  it("disables Publish or Unpublish and offers See why in place of Preview", async () => {
    render(blockedView());
    const user = await openMenu("Post a");

    const blockedItem = screen.getByRole("menuitem", { name: ITEM.blocked });
    expect(blockedItem).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Unpublish" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull();
    // Editing stays open.
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    );
    expect(R.push).toHaveBeenCalledWith("/dashboard/settings/notices/block-a");
  });

  it("keeps Preview for an admin who cannot open the notices", async () => {
    render(blockedView({ canSeeNotices: false }));
    await openMenu("Post a");
    expect(
      screen.getByRole("menuitem", { name: ITEM.blocked }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("menuitem", { name: ITEM.seeWhyItIsBlocked }),
    ).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Preview" }),
    ).toBeInTheDocument();
  });

  it("★ shows nothing for a post with no told block (D21)", async () => {
    render(blockedView());
    await openMenu("Post b");
    expect(
      screen.getByRole("menuitem", { name: "Unpublish" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Preview" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: ITEM.blocked })).toBeNull();
  });

  it("a blocked submission cannot be approved, and can still be reviewed", async () => {
    render(
      blockedView({
        blogs: [post("a", { status: "pending_review" })],
        total: 1,
      }),
    );
    await openMenu("Post a");
    expect(
      screen.getByRole("menuitem", { name: ITEM.blocked }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Approve" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: /Review & edit/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Reject" }),
    ).toBeInTheDocument();
  });

  it("hands the editor the post's block and the notices permission", async () => {
    vi.mocked(getBlogForEditor).mockResolvedValueOnce(post("a") as any);
    render(blockedView());
    const user = await openMenu("Post a");
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByTestId("blog-editor")).toHaveTextContent(
      "open:edit:- blocked:block-a notices:true",
    );
  });

  it("hands the editor no block for a post StoreMink did not block", async () => {
    vi.mocked(getBlogForEditor).mockResolvedValueOnce(post("b") as any);
    render(blockedView());
    const user = await openMenu("Post b");
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByTestId("blog-editor")).toHaveTextContent(
      "blocked:-",
    );
  });
});

describe("BlogEditorDialog for a post StoreMink blocked", () => {
  const editor = (props: Record<string, unknown>) => (
    <BlogEditorDialog
      open
      blog={post("a", { content: "<p>Hello</p>" })}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      categoryOptions={[]}
      tagOptions={[]}
      mediaUrlPrefix=""
      {...props}
    />
  );

  it("shows the banner with See why, keeps saving, and replaces the status switch", async () => {
    render(editor({ blockedByStoreMink: "block-a", canSeeNotices: true }));

    const banner = await screen.findByTestId("blog-blocked-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(itemBlockedBanner("blog_post"));
    expect(
      within(banner).getByRole("link", { name: ITEM.seeWhy }),
    ).toHaveAttribute("href", "/dashboard/settings/notices/block-a");

    // ★ Saving stays open.
    expect(screen.getByRole("button", { name: "Update Blog" })).toBeEnabled();
    // The status switch reads Blocked by StoreMink instead of Draft/Published.
    expect(screen.queryByRole("button", { name: "Draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
    expect(screen.getAllByText(ITEM.blocked).length).toBeGreaterThan(0);
  });

  it("shows no See why to an admin who cannot open the notices", async () => {
    render(editor({ blockedByStoreMink: "block-a" }));
    const banner = await screen.findByTestId("blog-blocked-banner");
    expect(within(banner).queryByRole("link")).toBeNull();
  });

  it("★ shows nothing for a post with no told block (D21)", async () => {
    render(editor({ blockedByStoreMink: null, canSeeNotices: true }));
    expect(await screen.findByText("Edit Blog")).toBeInTheDocument();
    expect(screen.queryByTestId("blog-blocked-banner")).toBeNull();
    expect(screen.getByRole("button", { name: "Draft" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Published" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(ITEM.blocked)).toBeNull();
  });

  it("a new post is never shown as blocked", async () => {
    render(
      editor({
        blog: null,
        blockedByStoreMink: "block-a",
        canSeeNotices: true,
      }),
    );
    expect(await screen.findByText("New Blog")).toBeInTheDocument();
    expect(screen.queryByTestId("blog-blocked-banner")).toBeNull();
  });
});
