import { describe, it, expect } from "vitest";
import { dedupeById, pageUrl } from "./rss";
import type { FeedSource } from "./feeds";
import type { FeedItem } from "./types";

// Only the pure parts are unit-tested: parsing needs DOMParser, which the node
// test environment does not have, and the browser smoke covers it end to end.

const source = (overrides: Partial<FeedSource> = {}): FeedSource => ({
  id: "s",
  title: "S",
  url: "https://example.com/feed/",
  pageParam: "paged",
  pages: 5,
  ...overrides,
});

const item = (id: string): FeedItem => ({
  id,
  title: id,
  link: id,
  content: "",
  categories: [],
  publishedAt: 0,
  sourceId: "s",
  sourceTitle: "S",
});

describe("pageUrl", () => {
  it("keeps page 1 canonical and adds the source's own page parameter after it", () => {
    expect(pageUrl(source(), 1)).toBe("https://example.com/feed/");
    expect(pageUrl(source(), 3)).toBe("https://example.com/feed/?paged=3");
    expect(pageUrl(source({ pageParam: "page" }), 2)).toBe("https://example.com/feed/?page=2");
  });

  it("preserves a query string the source already carries", () => {
    const withQuery = source({ url: "https://example.com/feed?tag=rust" });
    expect(pageUrl(withQuery, 2)).toBe("https://example.com/feed?tag=rust&paged=2");
  });
});

describe("dedupeById", () => {
  it("keeps the first occurrence, so overlapping pages do not double up", () => {
    const items = [item("a"), item("b"), item("a"), item("c")];
    expect(dedupeById(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
