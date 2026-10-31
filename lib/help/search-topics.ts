/**
 * The "Filter by topic" column of the Help search page. Pure and client-safe.
 *
 * A search result's link is `/help/<topic>/<guide>`, so its topic is read from
 * the link rather than added to every search result: the search action is
 * shared with the search box and Mink AI, which do not need it.
 */

export interface SearchTopicCategory {
  slug: string;
  title: string;
  position: number;
}

export interface SearchTopicCount {
  slug: string;
  title: string;
  count: number;
}

/** The topic slug of a Help guide link, or null when it is not one. */
export function helpUrlTopic(url: string): string | null {
  const match = /^\/help\/([^/?#]+)\/[^/?#]+\/?$/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * How many results each topic holds, most first, then in the Help Centre's
 * own topic order. A topic with no results, or one the Help Centre no longer
 * lists, is left out.
 */
export function searchTopicCounts(
  results: readonly { url: string }[],
  categories: readonly SearchTopicCategory[],
): SearchTopicCount[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    const slug = helpUrlTopic(result.url);
    if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return categories
    .filter((category) => counts.has(category.slug))
    .map((category) => ({
      slug: category.slug,
      title: category.title,
      count: counts.get(category.slug) ?? 0,
      position: category.position,
    }))
    .sort((a, b) => b.count - a.count || a.position - b.position)
    .map(({ slug, title, count }) => ({ slug, title, count }));
}

/** The results in one topic, or all of them when no topic is chosen. */
export function filterByTopic<T extends { url: string }>(
  results: readonly T[],
  topic: string | null,
): T[] {
  if (!topic) return [...results];
  return results.filter((result) => helpUrlTopic(result.url) === topic);
}

/** The search page's address for a search, optionally narrowed to a topic. */
export function helpSearchHref(query: string, topic?: string | null): string {
  const params = new URLSearchParams({ q: query });
  if (topic) params.set("topic", topic);
  return `/help/search?${params.toString()}`;
}
