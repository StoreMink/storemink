// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { search, categories, openHelpMink } = vi.hoisted(() => ({
  search: vi.fn(),
  categories: vi.fn(),
  openHelpMink: vi.fn(),
}));
vi.mock("@/app/actions/help-actions", () => ({
  searchPublishedHelpWithAi: search,
}));
vi.mock("@/lib/help/queries", () => ({ getHelpCategories: categories }));
vi.mock("../components/mink-launch", () => ({ openHelpMink }));

import HelpSearchPage from "./page";

const RESULTS = [
  {
    title: "Connect a domain you own",
    url: "/help/domains/connect-a-domain",
    excerpt: "Point a domain you bought to your store.",
  },
  {
    title: "Your free storemink.com address",
    url: "/help/getting-started/free-address",
    excerpt: "Replace it with your own domain any time.",
  },
  {
    title: "My domain is not working",
    url: "/help/domains/domain-not-working",
    excerpt: null,
  },
];

function category(slug: string, title: string, position: number) {
  return {
    id: slug,
    slug,
    title,
    description: null,
    icon: null,
    position,
  };
}

async function renderPage(params: Record<string, string>) {
  render(await HelpSearchPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue({ results: RESULTS, mode: "keyword" });
  categories.mockResolvedValue([
    category("getting-started", "Getting started", 0),
    category("domains", "Custom Domain", 1),
  ]);
});

describe("Help search results", () => {
  it("lists every guide with its topic and the search words marked", async () => {
    await renderPage({ q: "domain" });
    expect(search).toHaveBeenCalledWith("domain");
    expect(
      screen.getByRole("heading", { level: 1, name: "3 guides for “domain”" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sorted by best match")).toBeInTheDocument();

    const first = screen.getByRole("link", {
      name: /Connect a domain you own/,
    });
    expect(first).toHaveAttribute("href", "/help/domains/connect-a-domain");
    expect(first).toHaveTextContent("Custom Domain");
    const marks = first.querySelectorAll("mark");
    expect(Array.from(marks).map((mark) => mark.textContent)).toEqual([
      "domain",
      "domain",
    ]);
  });

  it("counts results per topic, most first, with All topics chosen", async () => {
    await renderPage({ q: "domain" });
    const filter = screen.getByRole("navigation", { name: "Filter by topic" });
    const links = within(filter).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "All topics3",
      "Custom Domain2",
      "Getting started1",
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "page");
    expect(links[1]).toHaveAttribute(
      "href",
      "/help/search?q=domain&topic=domains",
    );
  });

  it("narrows to one topic from the address", async () => {
    await renderPage({ q: "domain", topic: "domains" });
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "2 guides for “domain” in Custom Domain",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Your free storemink.com address/ }),
    ).not.toBeInTheDocument();
    const filter = screen.getByRole("navigation", { name: "Filter by topic" });
    expect(
      within(filter).getByRole("link", { name: /Custom Domain/ }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows everything for a topic that holds none of the results", async () => {
    await renderPage({ q: "domain", topic: "marketing" });
    expect(
      screen.getByRole("heading", { level: 1, name: "3 guides for “domain”" }),
    ).toBeInTheDocument();
  });

  it("says when the AI read the question, and that every result is a real guide", async () => {
    search.mockResolvedValue({ results: RESULTS, mode: "ai" });
    await renderPage({ q: "मेरा डोमेन" });
    expect(screen.getByRole("status")).toHaveTextContent(
      /real, published StoreMink guide/,
    );
  });

  it("offers other searches, Mink AI and support when nothing matches", async () => {
    search.mockResolvedValue({ results: [], mode: "keyword" });
    await renderPage({ q: "warp drive" });
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "No guides for “warp drive”",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Filter by topic" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "contact support" }),
    ).toHaveAttribute("href", "/help#contact");
    expect(
      screen.getByRole("link", { name: "Cash on Delivery" }),
    ).toHaveAttribute("href", "/help/search?q=cash+on+delivery");

    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    expect(openHelpMink).toHaveBeenCalledWith({
      mode: "chat",
      question: "warp drive",
      expand: true,
    });
  });

  it("does not search an empty box", async () => {
    await renderPage({});
    expect(search).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { level: 1, name: "Search the Help Centre" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    expect(openHelpMink).toHaveBeenCalledWith({
      mode: "chat",
      question: undefined,
      expand: true,
    });
  });

  it("links back to the Help Centre and contact support from the rail", async () => {
    await renderPage({ q: "domain" });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs).getByRole("link", { name: "Help Centre" }),
    ).toHaveAttribute("href", "/help");
    const rail = screen.getByRole("complementary", { name: "More help" });
    expect(
      within(rail).getByRole("link", { name: "Contact support" }),
    ).toHaveAttribute("href", "/help#contact");
    expect(rail).toHaveTextContent("“domain”");
  });
});
