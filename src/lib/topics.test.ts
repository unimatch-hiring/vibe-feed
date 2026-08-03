import { describe, it, expect } from "vitest";
import { collectTopics, mergeCatalog, searchTopics } from "./topics";
import type { FeedItem } from "./types";

const item = (id: string, categories: string[], sourceId = "a"): FeedItem => ({
  id,
  title: id,
  link: `https://example.com/${id}`,
  content: "",
  categories,
  publishedAt: 0,
  sourceId,
  sourceTitle: sourceId,
});

describe("collectTopics", () => {
  it("pools both sources, de-duplicates case-insensitively and ranks by frequency", () => {
    const options = collectTopics([
      item("a1", ["AI", "RSS"], "github"),
      item("a2", ["ai", "Browser"], "github"),
      item("b1", ["  Ai  ", "browser"], "devto"),
    ]);

    // Every spelling of "ai" was used exactly once, so the tie falls back to the
    // alphabetical one; "RSS" is the only spelling of its topic.
    expect(options).toEqual([
      { topic: "ai", label: "ai", count: 3 },
      { topic: "browser", label: "browser", count: 2 },
      { topic: "rss", label: "RSS", count: 1 },
    ]);
  });

  it("counts an article once per topic and drops empty tags", () => {
    const options = collectTopics([item("a1", ["AI", "ai", " ", ""])]);
    expect(options).toEqual([{ topic: "ai", label: "AI", count: 1 }]);
  });

  it("folds spelling variants into one topic and labels it with the common one", () => {
    const options = collectTopics([
      item("a1", ["Open Source"], "github"),
      item("a2", ["opensource"], "devto"),
      item("a3", ["Open Source"], "github"),
    ]);
    expect(options).toEqual([{ topic: "open source", label: "Open Source", count: 3 }]);
  });

  it("leaves out sections of a publication, which are not interests", () => {
    const options = collectTopics([item("a1", ["Company news", "News & insights", "Security"])]);
    expect(options.map((o) => o.topic)).toEqual(["security"]);
  });

  it("splits a tag that joins two topics, and leaves a compound name whole", () => {
    const options = collectTopics([
      item("a1", ["ai"]),
      item("a2", ["ai"]),
      item("a3", ["AI & ML"]),
      item("a4", ["GitHub Copilot"]),
    ]);
    // "AI & ML" names two interests, so it feeds "ai" (which then counts three
    // articles) and "ml". "GitHub Copilot" is one name and stays one chip.
    expect(options).toEqual([
      { topic: "ai", label: "ai", count: 3 },
      { topic: "github copilot", label: "GitHub Copilot", count: 1 },
      { topic: "ml", label: "ml", count: 1 },
    ]);
  });

  it("keeps only the most frequent topics up to the limit", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      // topic-00 appears on every article, the rest once each.
      item(`i${index}`, ["shared", `topic-${String(index).padStart(2, "0")}`])
    );
    const options = collectTopics(items);

    expect(options).toHaveLength(20);
    expect(options[0]).toEqual({ topic: "shared", label: "shared", count: 25 });
    expect(options.map((o) => o.topic)).not.toContain("topic-24");
  });
});

describe("searchTopics", () => {
  const catalog = collectTopics([
    item("a1", ["Rust", "Rustacean", "Go"]),
    item("a2", ["Rust", "Go"]),
    item("a3", ["Go"]),
  ]);

  it("finds topics that are not already on screen", () => {
    // "go" and "rust" are shown as chips; only the long-tail tag is offered.
    expect(searchTopics(catalog, "rust", ["go", "rust"]).map((o) => o.topic)).toEqual([
      "rustacean",
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchTopics(catalog, "  ", [])).toEqual([]);
  });
});

describe("mergeCatalog", () => {
  it("keeps shown topics in place with fresh counts and appends new ones", () => {
    const shown = collectTopics([item("a1", ["Rust", "Go"])]);
    const next = collectTopics([
      item("a1", ["Rust", "Go"]),
      item("a2", ["Go", "Zig"]),
      item("a3", ["Zig"]),
      item("a4", ["Zig"]),
    ]);

    // "zig" now outranks both, but the picker must not reshuffle: the two chips
    // already on screen keep their slots and only their counts change.
    expect(next.map((o) => o.topic)).toEqual(["zig", "go", "rust"]);
    expect(mergeCatalog(shown, next)).toEqual([
      { topic: "go", label: "Go", count: 2 },
      { topic: "rust", label: "Rust", count: 1 },
      { topic: "zig", label: "Zig", count: 3 },
    ]);
  });

  it("drops a shown topic that the newer catalogue no longer offers", () => {
    const shown = collectTopics([item("a1", ["Rust"]), item("a2", ["Company news"])]);
    // Only a topic still on offer survives the merge; anything the newer
    // catalogue dropped leaves without disturbing the others.
    const next = collectTopics([item("a1", ["Rust"])]);
    expect(mergeCatalog([...shown, { topic: "gone", label: "Gone", count: 1 }], next)).toEqual([
      { topic: "rust", label: "Rust", count: 1 },
    ]);
  });
});
