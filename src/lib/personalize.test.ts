import { describe, it, expect } from "vitest";
import {
  EMPTY_PROFILE,
  personalize,
  toggleTopic,
  type PersonalizationProfile,
} from "./personalize";
import type { FeedItem } from "./types";

const item = (id: string, overrides: Partial<FeedItem> = {}): FeedItem => ({
  id,
  title: id,
  link: `https://example.com/${id}`,
  content: "",
  categories: [],
  publishedAt: 0,
  sourceId: "s",
  sourceTitle: "S",
  ...overrides,
});

const profile = (overrides: Partial<PersonalizationProfile> = {}): PersonalizationProfile => ({
  ...EMPTY_PROFILE,
  ...overrides,
});

const ids = (items: FeedItem[]): string[] => items.map((i) => i.id);

describe("personalize", () => {
  it("ranks a category match above a newer article without one, across sources", () => {
    const items = [
      item("newer", { title: "Weather report", publishedAt: 2000, sourceId: "github" }),
      item("match", { categories: ["Rust"], publishedAt: 1000, sourceId: "devto" }),
    ];
    expect(ids(personalize(items, profile({ topics: ["rust"] })))).toEqual(["match", "newer"]);
  });

  it("ranks by how many chosen topics an article matches", () => {
    const items = [
      item("one", { categories: ["rust"], publishedAt: 3000 }),
      item("two", { categories: ["Rust", "RSS"], publishedAt: 1000 }),
    ];
    expect(ids(personalize(items, profile({ topics: ["rust", "rss"] })))).toEqual(["two", "one"]);
  });

  it("ranks a published tag above a mere mention of the same topic", () => {
    const items = [
      item("mention", { content: "<p>rust, rust, rust everywhere</p>", publishedAt: 2000 }),
      item("tagged", { categories: ["Rust"], publishedAt: 1000 }),
    ];
    expect(ids(personalize(items, profile({ topics: ["rust"] })))).toEqual(["tagged", "mention"]);
  });

  it("matches whole words only, so a short topic is not a substring hit", () => {
    const items = [
      item("substring", {
        title: "Try again",
        content: "<p>Send an email and maintain the details</p>",
        publishedAt: 2000,
      }),
      item("real", { content: "<p>Everything about AI tooling</p>", publishedAt: 1000 }),
    ];
    expect(ids(personalize(items, profile({ topics: ["ai"] })))).toEqual(["real", "substring"]);
  });

  it("falls back to recency with stable input order for equal dates", () => {
    const items = [
      item("old", { publishedAt: 1000 }),
      item("first-new", { publishedAt: 2000 }),
      item("second-new", { publishedAt: 2000 }),
    ];
    expect(ids(personalize(items, EMPTY_PROFILE))).toEqual(["first-new", "second-new", "old"]);
  });

  it("ignores the topic score in latest mode and orders by date", () => {
    const items = [
      item("tagged-old", { categories: ["Rust"], publishedAt: 1000 }),
      item("untagged-new", { publishedAt: 2000 }),
    ];
    const topics = ["rust"];
    expect(ids(personalize(items, profile({ topics, sortMode: "relevant" })))).toEqual([
      "tagged-old",
      "untagged-new",
    ]);
    expect(ids(personalize(items, profile({ topics, sortMode: "latest" })))).toEqual([
      "untagged-new",
      "tagged-old",
    ]);
  });

  it("does not mutate the input array", () => {
    const items = [item("old", { publishedAt: 1000 }), item("new", { publishedAt: 2000 })];
    const before = [...items];
    personalize(items, profile({ topics: ["new"] }));
    expect(items).toEqual(before);
  });
});

describe("toggleTopic", () => {
  it("adds a normalized topic and removes it when chosen again", () => {
    expect(toggleTopic([], " Rust ")).toEqual(["rust"]);
    expect(toggleTopic(["rust", "rss"], "RUST")).toEqual(["rss"]);
  });
});
