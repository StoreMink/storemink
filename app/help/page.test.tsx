// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const {
  connection,
  categories,
  counts,
  popular,
  navTree,
  categoryCards,
  minkConfig,
} = vi.hoisted(() => ({
  connection: vi.fn(),
  categories: vi.fn(),
  counts: vi.fn(),
  popular: vi.fn(),
  navTree: vi.fn(),
  categoryCards: vi.fn(),
  minkConfig: vi.fn(() => ({ enabled: true })),
}));
vi.mock("next/server", () => ({ connection }));
vi.mock("@/lib/mink/config", () => ({ getMinkConfig: minkConfig }));
vi.mock("@/lib/help/queries", () => ({
  getHelpCategories: categories,
  getHelpCategoryCounts: counts,
  getPopularHelpArticles: popular,
  getHelpNavTree: navTree,
  getHelpArticleCardsByCategory: categoryCards,
}));
vi.mock("./components/search-box", () => ({
  HelpSearchBox: () => <div>Search guides</div>,
}));
import HelpHome from "./page";
import HelpError from "./error";

function card(id: string, slug: string, title: string, categoryId = "start") {
  return {
    id,
    categoryId,
    slug,
    title,
    excerpt: `About ${title.toLowerCase()}.`,
    status: "published" as const,
    position: 0,
    viewCount: 0,
    updatedAt: null,
    publishedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connection.mockResolvedValue(undefined);
  categories.mockResolvedValue([
    {
      id: "start",
      slug: "getting-started",
      title: "Getting started",
      description: "Start here",
      icon: "rocket",
      position: 0,
    },
    {
      id: "domains",
      slug: "domains",
      title: "Domains",
      description: "Connect your own address",
      icon: "globe",
      position: 1,
    },
  ]);
  counts.mockResolvedValue({ start: 8, domains: 1 });
  popular.mockResolvedValue([
    card(
      "p1",
      "connect-a-custom-domain",
      "Connect a domain you own",
      "domains",
    ),
  ]);
  navTree.mockResolvedValue([
    {
      slug: "getting-started",
      title: "Getting started",
      articles: [
        { slug: "create-your-store", title: "Create your StoreMink store" },
        { slug: "complete-setup", title: "Complete your store setup" },
        { slug: "dashboard-tour", title: "Understand your dashboard" },
        { slug: "fourth", title: "A fourth guide" },
      ],
    },
    {
      slug: "domains",
      title: "Domains",
      articles: [
        { slug: "connect-a-custom-domain", title: "Connect a domain you own" },
      ],
    },
  ]);
  categoryCards.mockResolvedValue([
    card("a1", "create-your-store", "Create your StoreMink store"),
    card("a2", "complete-setup", "Complete your store setup"),
    card("a3", "dashboard-tour", "Understand your dashboard"),
    card("a4", "first-product", "Add your first product"),
    card("a5", "fifth", "A fifth guide"),
  ]);
  minkConfig.mockReturnValue({ enabled: true });
});

describe("Help Centre home", () => {
  it("waits for a request before any data read, then renders topics without a reload", async () => {
    let acceptRequest!: () => void;
    connection.mockReturnValue(
      new Promise<void>((resolve) => {
        acceptRequest = resolve;
      }),
    );
    const pending = HelpHome();
    expect(categories).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
    expect(popular).not.toHaveBeenCalled();
    expect(navTree).not.toHaveBeenCalled();
    acceptRequest();
    render(await pending);
    const topics = screen.getByRole("region", { name: "Browse by topic" });
    expect(
      within(topics).getByRole("link", { name: /^Getting started/ }),
    ).toHaveAttribute("href", "/help/getting-started");
    expect(
      screen.queryByText(/Articles are on their way/),
    ).not.toBeInTheDocument();
  });

  it("lists each topic's first three guides and links to all of them by count", async () => {
    render(await HelpHome());
    const topics = screen.getByRole("region", { name: "Browse by topic" });
    expect(
      within(topics).getByRole("link", { name: "Understand your dashboard" }),
    ).toHaveAttribute("href", "/help/getting-started/dashboard-tour");
    expect(
      within(topics).queryByRole("link", { name: "A fourth guide" }),
    ).not.toBeInTheDocument();
    const viewAll = within(topics).getByRole("link", {
      name: "View all 8 Getting started guides",
    });
    expect(viewAll).toHaveAttribute("href", "/help/getting-started");
    expect(viewAll).toHaveTextContent("View all 8 guides");
    // One guide reads as one guide, not "1 guides".
    expect(
      within(topics).getByRole("link", { name: "View all 1 Domains guides" }),
    ).toHaveTextContent("View all 1 guide");
  });

  it("shows popular guides with their topic, linked to the guide", async () => {
    render(await HelpHome());
    const list = screen.getByRole("region", { name: "Popular guides" });
    const link = within(list).getByRole("link", {
      name: /Connect a domain you own/,
    });
    expect(link).toHaveAttribute(
      "href",
      "/help/domains/connect-a-custom-domain",
    );
    expect(link).toHaveTextContent("Domains");
  });

  it("leaves out a popular guide whose topic no longer exists", async () => {
    popular.mockResolvedValue([
      card("orphan", "lost-guide", "A guide with no topic", "gone"),
    ]);
    render(await HelpHome());
    expect(
      screen.queryByRole("region", { name: "Popular guides" }),
    ).not.toBeInTheDocument();
  });

  it("starts new sellers on the first four getting-started guides, in order", async () => {
    render(await HelpHome());
    expect(categoryCards).toHaveBeenCalledWith("start");
    const start = screen.getByRole("region", {
      name: "New to StoreMink? Start here",
    });
    const links = within(start).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/help/getting-started/create-your-store",
      "/help/getting-started/complete-setup",
      "/help/getting-started/dashboard-tour",
      "/help/getting-started/first-product",
    ]);
  });

  it("skips the start-here section when there is no getting-started topic", async () => {
    categories.mockResolvedValue([
      {
        id: "domains",
        slug: "domains",
        title: "Domains",
        description: null,
        icon: "globe",
        position: 0,
      },
    ]);
    render(await HelpHome());
    expect(categoryCards).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "New to StoreMink? Start here" }),
    ).not.toBeInTheDocument();
  });

  it("links popular searches to real searches", async () => {
    render(await HelpHome());
    expect(
      screen.getByRole("link", { name: "Cash on Delivery" }),
    ).toHaveAttribute("href", "/help/search?q=cash%20on%20delivery");
    expect(screen.getByRole("link", { name: "GST invoice" })).toHaveAttribute(
      "href",
      "/help/search?q=GST%20invoice",
    );
  });

  it("offers Mink AI by text and by voice, and a way to email support", async () => {
    render(await HelpHome());
    expect(
      screen.getAllByRole("button", { name: /Ask Mink AI/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Talk with Mink AI" }),
    ).toBeInTheDocument();
    const still = screen.getByRole("region", { name: "Still need help?" });
    expect(still).toHaveAttribute("id", "contact");
    expect(
      within(still).getByRole("link", { name: "support@storemink.com" }),
    ).toHaveAttribute("href", "mailto:support@storemink.com");
  });

  it("leaves out the voice button while Mink AI is switched off", async () => {
    minkConfig.mockReturnValue({ enabled: false });
    render(await HelpHome());
    expect(
      screen.queryByRole("button", { name: "Talk with Mink AI" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Ask Mink AI/ }).length,
    ).toBeGreaterThan(0);
  });

  it("says guides are coming, with the support address, when there are no topics", async () => {
    categories.mockResolvedValue([]);
    navTree.mockResolvedValue([]);
    popular.mockResolvedValue([]);
    render(await HelpHome());
    expect(screen.getByText(/Articles are on their way/)).toBeInTheDocument();
  });

  it("propagates unavailable reads to the error boundary instead of rendering no articles", async () => {
    const error = new Error("database unavailable");
    categories.mockRejectedValue(error);
    await expect(HelpHome()).rejects.toBe(error);
  });

  it("offers a server re-fetch on failure without exposing the database error", () => {
    const retry = vi.fn();
    render(
      <HelpError
        error={new Error("private database connection details")}
        unstable_retry={retry}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Help Centre is temporarily unavailable",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
