import { describe, it, expect } from "vitest";
// Vite `?raw` import, not node:fs: @types/node isn't a dependency and `tsc -b`
// type-checks the tests too. Typed by vite/client via src/vite-env.d.ts.
import FEED_XML from "../../public/mock-feed.xml?raw";
import {
  personalize,
  rankFeed,
  dedupe,
  recencyScore,
  interestVector,
  EMPTY_INTERESTS,
  type UserInterests,
} from "./personalize";
import type { FeedItem } from "./types";

const HOUR = 3600_000;
const NOW = Date.parse("2026-06-16T12:00:00Z");

// Mirrors MATCH_THRESHOLD in personalize.ts: above this a card reads "matches your
// interests" rather than "weak match". A chip's own article must clear it, or the UI
// disowns the very match it just ranked first.
const MATCH_LABEL_FLOOR = 0.15;

// The fixture IS public/mock-feed.xml, parsed at test time — all 8 items with their
// full content:encoded bodies. An abridged hand-copied fixture is what let the
// ranking ship broken: it held 6 items, omitting exactly the two articles
// (indexeddb-caching, graceful-degradation) whose long bodies inverted relevance,
// and shortened the rest so body dilution never showed up. Reading the real file
// means the fixture cannot drift from what the app actually serves.
// Minimal RSS reader for the fixture. rss.ts's parseFeedXml needs a DOM and returns
// [] under Node, so the parse is duplicated here rather than mocking a DOMParser.
function parseMockFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const tag = (name: string): string => {
      const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
      if (found === null) return "";
      return found[1]
        .replace(/^\s*<!\[CDATA\[/, "")
        .replace(/\]\]>\s*$/, "")
        .trim();
    };

    const link = tag("link");
    items.push({
      id: link,
      title: tag("title"),
      link,
      content: tag("content:encoded") || tag("description"),
      publishedAt: Date.parse(tag("pubDate")) || 0,
      sourceId: "local",
      sourceTitle: "Local mock feed",
    });
  }
  return items;
}

const MOCK_ITEMS = parseMockFeed(FEED_XML);

const byLink = (slug: string): FeedItem => {
  const found = MOCK_ITEMS.find((i) => i.link === `https://example.com/${slug}`);
  if (found === undefined) throw new Error(`fixture missing ${slug}`);
  return found;
};

const webgpu = byLink("webgpu-baseline");
const showHn = byLink("show-hn-client-side-reader");
const corsProxy = byLink("cors-proxy-cost");
const smallLlm = byLink("small-llm-summarization");
const showHnDup = byLink("show-hn-client-side-reader-dup");
const rss = byLink("rss-comeback");
const indexedDb = byLink("indexeddb-caching");
const gracefulDegradation = byLink("graceful-degradation");

const mk = (
  link: string,
  title: string,
  content: string,
  publishedAt: number
): FeedItem => ({
  id: `https://example.com/${link}`,
  title,
  link: `https://example.com/${link}`,
  content,
  publishedAt,
  sourceId: "local",
  sourceTitle: "Local mock feed",
});

describe("fixture", () => {
  it("is the real feed: 8 items with full bodies, including the two that expose dilution", () => {
    expect(MOCK_ITEMS).toHaveLength(8);
    expect(MOCK_ITEMS.map((i) => i.link)).toContain(indexedDb.link);
    expect(MOCK_ITEMS.map((i) => i.link)).toContain(gracefulDegradation.link);
    // Full content:encoded bodies, not abridged one-liners.
    for (const item of MOCK_ITEMS) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.publishedAt).toBeGreaterThan(0);
    }
    // Real bodies are multi-paragraph (800+ chars); the old fixture abridged them
    // to ~200-300, which is what hid the dilution.
    for (const item of MOCK_ITEMS.filter((i) => i.link !== showHnDup.link)) {
      expect(item.content.length).toBeGreaterThan(700);
    }
    expect(webgpu.content.length).toBeGreaterThan(1000);
  });
});

const interests = (over: Partial<UserInterests> = {}): UserInterests => ({
  topics: [],
  liked: [],
  disliked: [],
  ...over,
});

const rank = (id: string, scored: { item: FeedItem }[]): number =>
  scored.findIndex((s) => s.item.id === id);

describe("recencyScore", () => {
  it("is exactly 1 for something published right now", () => {
    expect(recencyScore(NOW, NOW)).toBe(1);
  });

  it("is ~0.5 at exactly 48h old (the half-life)", () => {
    expect(recencyScore(NOW - 48 * HOUR, NOW)).toBeCloseTo(0.5, 2);
  });

  it("decreases strictly across 0h / 24h / 48h / 1 week", () => {
    const scores = [0, 24, 48, 24 * 7].map((h) => recencyScore(NOW - h * HOUR, NOW));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
    expect(scores.every((s) => s >= 0 && s <= 1)).toBe(true);
  });

  it("clamps future timestamps to 1 rather than exceeding the range", () => {
    expect(recencyScore(NOW + 10 * HOUR, NOW)).toBe(1);
  });

  it("gives an unparseable date (publishedAt === 0) a finite floor, not garbage", () => {
    const s = recencyScore(0, NOW);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(recencyScore(NOW - 24 * 7 * HOUR, NOW));
  });
});

describe("dedupe", () => {
  it("collapses the two 'client-side news reader' cross-posts into one", () => {
    const { kept, collapsed } = dedupe(MOCK_ITEMS);

    expect(kept).toHaveLength(MOCK_ITEMS.length - 1);
    const keptIds = kept.map((k) => k.id);
    expect(keptIds).toContain(showHn.id);
    expect(keptIds).not.toContain(showHnDup.id);

    // Kept the longer-content original; the shorter cross-post is collapsed under it.
    expect(collapsed.size).toBe(1);
    expect(collapsed.get(showHn.id)).toEqual([showHnDup]);
  });

  it("does not collapse genuinely different articles", () => {
    const { kept, collapsed } = dedupe([webgpu, corsProxy]);
    expect(kept).toEqual([webgpu, corsProxy]);
    expect(collapsed.size).toBe(0);
  });

  it("returns empty results for empty input", () => {
    const { kept, collapsed } = dedupe([]);
    expect(kept).toEqual([]);
    expect(collapsed.size).toBe(0);
  });
});

describe("interestVector", () => {
  it("is all-zero at cold start", () => {
    const v = interestVector(EMPTY_INTERESTS, MOCK_ITEMS);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("is non-zero once a topic is stated", () => {
    const v = interestVector(interests({ topics: ["webgpu gpu compute"] }), MOCK_ITEMS);
    expect(v.some((x) => x !== 0)).toBe(true);
  });

  it("is non-zero from likes alone (no topics)", () => {
    const v = interestVector(interests({ liked: [webgpu.id] }), MOCK_ITEMS);
    expect(v.some((x) => x !== 0)).toBe(true);
  });
});

describe("rankFeed", () => {
  it("returns [] for an empty feed", () => {
    expect(rankFeed([], EMPTY_INTERESTS, NOW)).toEqual([]);
  });

  // The chips App.tsx actually ships, verbatim — not a padded-out phrase. A
  // multi-word query like "webgpu gpu compute in the browser" occupies enough
  // buckets to survive a broken embedder; the bare chip is what users click.
  const CHIP_CASES: { topic: string; expected: FeedItem; label: string }[] = [
    { topic: "webgpu", expected: webgpu, label: "WebGPU Baseline" },
    { topic: "offline caching", expected: indexedDb, label: "IndexedDB caching" },
    { topic: "cors", expected: corsProxy, label: "CORS proxies" },
    { topic: "llm summarization", expected: smallLlm, label: "small language models" },
  ];

  for (const { topic, expected, label } of CHIP_CASES) {
    it(`ranks ${label} #1 with the strongest semantic for the shipped chip "${topic}"`, () => {
      const scored = rankFeed(MOCK_ITEMS, interests({ topics: [topic] }), NOW);
      const target = scored.find((s) => s.item.id === expected.id);
      expect(target).toBeDefined();

      // Assert on the semantic term itself, not just final position: recency alone
      // could otherwise float the right article to the top while the semantic
      // component is broken (or inverted, as it was with title+body concatenated).
      const others = scored.filter((s) => s.item.id !== expected.id);
      for (const other of others) {
        expect(
          target!.semantic,
          `"${topic}": ${expected.title} (${target!.semantic.toFixed(4)}) must out-score ` +
            `${other.item.title} (${other.semantic.toFixed(4)}) on semantic`
        ).toBeGreaterThan(other.semantic);
      }

      expect(target!.semantic).toBeGreaterThan(MATCH_LABEL_FLOOR);
      expect(scored[0].item.id).toBe(expected.id);
    });
  }

  it("does not collapse every card to a zero score when there are only dislikes", () => {
    const scored = rankFeed(MOCK_ITEMS, interests({ disliked: [webgpu.id] }), NOW);

    // The regression: iv = -0.5*neg is non-zero, so the warm path ran, every cosine
    // came out negative, and clamping floored all of them to exactly 0 — top score
    // fell 0.9857 -> 0.246 and every card in the UI read "weak match (0.00)".
    expect(scored[0].score).toBeGreaterThan(0.9);
    expect(scored.every((s) => s.score > 0)).toBe(true);

    // A dislike must demote its target, not flatten the feed.
    const base = rankFeed(MOCK_ITEMS, EMPTY_INTERESTS, NOW);
    expect(rank(webgpu.id, scored)).toBeGreaterThan(rank(webgpu.id, base));
    expect(new Set(scored.map((s) => s.score)).size).toBeGreaterThan(1);
  });

  it("lets a dislike reorder, not merely flatten, when a topic is also stated", () => {
    const topics = ["cors proxy"];
    const base = rankFeed(MOCK_ITEMS, interests({ topics }), NOW);
    const withDislike = rankFeed(
      MOCK_ITEMS,
      interests({ topics, disliked: [corsProxy.id] }),
      NOW
    );

    // Disliking the article the topic matches must push it down the list. Clamping
    // negative similarity to 0 made every non-target score identical, so the dislike
    // could only squash the ranking and never reorder it.
    expect(rank(corsProxy.id, base)).toBe(0);
    expect(rank(corsProxy.id, withDislike)).toBeGreaterThan(0);
    const semantics = withDislike.map((s) => s.semantic);
    expect(new Set(semantics).size).toBeGreaterThan(1);
  });

  it("never produces a NaN or infinite score field", () => {
    const scored = rankFeed(
      [...MOCK_ITEMS, mk("blank", "", "", 0)],
      interests({ topics: ["webgpu"], liked: [rss.id], disliked: [corsProxy.id] }),
      NOW
    );
    for (const s of scored) {
      expect(Number.isFinite(s.score)).toBe(true);
      expect(Number.isFinite(s.semantic)).toBe(true);
      expect(Number.isFinite(s.recency)).toBe(true);
      expect(Number.isFinite(s.feedback)).toBe(true);
    }
  });

  it("raises an item's position when it is liked", () => {
    const base = rankFeed(MOCK_ITEMS, EMPTY_INTERESTS, NOW);
    const liked = rankFeed(MOCK_ITEMS, interests({ liked: [rss.id] }), NOW);
    expect(rank(rss.id, liked)).toBeLessThan(rank(rss.id, base));
  });

  it("lowers an item's position when it is disliked", () => {
    const base = rankFeed(MOCK_ITEMS, EMPTY_INTERESTS, NOW);
    const disliked = rankFeed(MOCK_ITEMS, interests({ disliked: [webgpu.id] }), NOW);
    expect(rank(webgpu.id, disliked)).toBeGreaterThan(rank(webgpu.id, base));
  });

  it("reports +1 / -1 / 0 feedback and reflects it in the score", () => {
    const scored = rankFeed(
      MOCK_ITEMS,
      interests({ liked: [rss.id], disliked: [corsProxy.id] }),
      NOW
    );
    const byId = new Map(scored.map((s) => [s.item.id, s]));
    expect(byId.get(rss.id)?.feedback).toBe(1);
    expect(byId.get(corsProxy.id)?.feedback).toBe(-1);
    expect(byId.get(webgpu.id)?.feedback).toBe(0);
  });

  it("falls back to newest-first at cold start", () => {
    const scored = rankFeed(MOCK_ITEMS, EMPTY_INTERESTS, NOW);

    expect(scored.every((s) => s.semantic === 0)).toBe(true);
    const dates = scored.map((s) => s.item.publishedAt);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
    }
  });

  it("keeps cold-start scores on a full 0..1 scale, not squashed by the recency weight", () => {
    const fresh = mk("fresh", "Some fresh headline", "body", NOW - 60_000);
    const scored = rankFeed([fresh, rss], EMPTY_INTERESTS, NOW);
    // Recency-only weighting (0.25 * recency) would cap this near 0.25 and read
    // as "no match" in the UI even though it is the newest item in the feed.
    expect(scored[0].item.id).toBe(fresh.id);
    expect(scored[0].score).toBeGreaterThan(0.9);
  });

  it("attaches collapsed duplicates to the kept item and to nobody else", () => {
    const scored = rankFeed(MOCK_ITEMS, EMPTY_INTERESTS, NOW);
    const byId = new Map(scored.map((s) => [s.item.id, s]));

    expect(byId.get(showHn.id)?.duplicates).toEqual([showHnDup]);
    expect(byId.has(showHnDup.id)).toBe(false);
    expect(byId.get(webgpu.id)?.duplicates).toEqual([]);
  });

  it("is sorted descending by score", () => {
    const scored = rankFeed(MOCK_ITEMS, interests({ topics: ["rss readers"] }), NOW);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i].score).toBeLessThanOrEqual(scored[i - 1].score);
    }
  });

  it("writes a non-empty why for every item, cold start included", () => {
    for (const i of [EMPTY_INTERESTS, interests({ topics: ["webgpu"] })]) {
      for (const s of rankFeed(MOCK_ITEMS, i, NOW)) {
        expect(s.why.length).toBeGreaterThan(0);
      }
    }
  });

  it("is stable for ties (equal scores keep input order)", () => {
    // Same title + content + timestamp differ only by id → identical scores.
    const a = mk("tie-a", "Identical headline text here", "same body text", NOW);
    const b = { ...a, id: "https://example.com/tie-b", link: "https://example.com/tie-b" };
    // Distinct titles so dedup doesn't collapse them.
    const scored = rankFeed(
      [
        { ...a, title: "Alpha topic one" },
        { ...b, title: "Beta subject two" },
      ],
      EMPTY_INTERESTS,
      NOW
    );
    expect(scored.map((s) => s.item.id)).toEqual([a.id, b.id]);
  });
});

describe("personalize", () => {
  it("equals rankFeed(...).map(s => s.item)", () => {
    const i = interests({ topics: ["webgpu"], liked: [rss.id] });
    expect(personalize(MOCK_ITEMS, i)).toEqual(rankFeed(MOCK_ITEMS, i).map((s) => s.item));
  });

  it("returns [] for an empty feed", () => {
    expect(personalize([], EMPTY_INTERESTS)).toEqual([]);
  });
});
