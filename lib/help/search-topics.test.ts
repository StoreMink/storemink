import { describe, expect, it } from "vitest";
import {
  filterByTopic,
  helpSearchHref,
  helpUrlTopic,
  searchTopicCounts,
} from "./search-topics";

const categories = [
  { slug: "getting-started", title: "Getting started", position: 0 },
  { slug: "account", title: "Plans and billing", position: 1 },
  { slug: "domains", title: "Custom Domain", position: 2 },
];

const results = [
  { url: "/help/domains/connect-a-domain" },
  { url: "/help/domains/buy-a-domain" },
  { url: "/help/getting-started/free-address" },
  { url: "/help/domains/domain-not-working" },
  { url: "/help/account/plans" },
  { url: "/help/retired-topic/old-guide" },
];

describe("helpUrlTopic", () => {
  it("reads the topic of a guide link", () => {
    expect(helpUrlTopic("/help/domains/connect-a-domain")).toBe("domains");
  });

  it("refuses anything that is not a guide link", () => {
    expect(helpUrlTopic("/help/domains")).toBeNull();
    expect(helpUrlTopic("/help/search?q=x")).toBeNull();
    expect(helpUrlTopic("https://example.com/help/a/b")).toBeNull();
  });
});

describe("searchTopicCounts", () => {
  it("counts results per topic, most first, then in topic order", () => {
    expect(searchTopicCounts(results, categories)).toEqual([
      { slug: "domains", title: "Custom Domain", count: 3 },
      { slug: "getting-started", title: "Getting started", count: 1 },
      { slug: "account", title: "Plans and billing", count: 1 },
    ]);
  });

  it("leaves out topics with no results and ones no longer listed", () => {
    const counts = searchTopicCounts(
      [{ url: "/help/retired-topic/old-guide" }],
      categories,
    );
    expect(counts).toEqual([]);
  });
});

describe("filterByTopic", () => {
  it("keeps one topic's results in their order", () => {
    expect(filterByTopic(results, "domains").map((r) => r.url)).toEqual([
      "/help/domains/connect-a-domain",
      "/help/domains/buy-a-domain",
      "/help/domains/domain-not-working",
    ]);
  });

  it("keeps everything when no topic is chosen", () => {
    expect(filterByTopic(results, null)).toHaveLength(results.length);
  });
});

describe("helpSearchHref", () => {
  it("builds the search address, with a topic when one is chosen", () => {
    expect(helpSearchHref("custom domain")).toBe(
      "/help/search?q=custom+domain",
    );
    expect(helpSearchHref("GST & invoice", "account")).toBe(
      "/help/search?q=GST+%26+invoice&topic=account",
    );
  });
});
