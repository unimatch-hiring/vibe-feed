import { describe, expect, it } from "vitest";
import { agenticRerank } from "./agent";
import { createWebLLMSummarizer } from "./summarizer";
import type { Summarizer } from "./summarizer";
import type { FeedItem, ScoredItem } from "./types";
import type { UserInterests } from "./personalize";

// Local fixtures only — no dependency on personalize.ts internals.
const interests: UserInterests = {
  topics: ["ai"],
  liked: [],
  disliked: [],
};

function item(id: string, title: string): FeedItem {
  return {
    id,
    title,
    link: `https://example.com/${id}`,
    content: title,
    publishedAt: 0,
    sourceId: "src",
    sourceTitle: "Src",
  };
}

function scored(id: string, title: string, score: number): ScoredItem {
  return {
    item: item(id, title),
    score,
    semantic: score,
    recency: 0,
    feedback: 0,
    cold: false,
    duplicates: [],
    why: "fixture",
  };
}

// a first, b second — the model should be able to flip that.
const candidates: ScoredItem[] = [
  scored("a", "Cheese prices rise", 0.8),
  scored("b", "New AI model released", 0.4),
];

function fakeSummarizer(reply: string): Summarizer {
  return { summarize: async () => reply };
}

const ids = (items: ScoredItem[]) => items.map((s) => s.item.id);

describe("agenticRerank", () => {
  it("reorders from well-formed scoreItem calls", async () => {
    const s = fakeSummarizer(
      [
        'scoreItem("b", 0.9, "matches their AI interest")',
        'scoreItem("a", 0.1, "off-topic")',
      ].join("\n")
    );
    expect(ids(await agenticRerank(candidates, interests, s))).toEqual(["b", "a"]);
  });

  it("accepts single quotes and loose whitespace", async () => {
    const s = fakeSummarizer(
      "Sure! Here you go:\n  scoreItem( 'b' , 0.77 , 'on topic' )\nscoreItem('a',0.2,'meh')"
    );
    expect(ids(await agenticRerank(candidates, interests, s))).toEqual(["b", "a"]);
  });

  it("reorders from the JSON array fallback", async () => {
    const s = fakeSummarizer(
      'Result: [{"id":"a","score":0.05,"reason":"no"},{"id":"b","score":0.8,"reason":"yes"}]'
    );
    expect(ids(await agenticRerank(candidates, interests, s))).toEqual(["b", "a"]);
  });

  it("returns input order unchanged on prose garbage", async () => {
    const s = fakeSummarizer(
      "I think the second article is more interesting than the first one, honestly."
    );
    expect(ids(await agenticRerank(candidates, interests, s))).toEqual(["a", "b"]);
  });

  it("returns input order unchanged when summarize rejects", async () => {
    const s: Summarizer = {
      summarize: async () => {
        throw new Error("engine died");
      },
    };
    expect(ids(await agenticRerank(candidates, interests, s))).toEqual(["a", "b"]);
  });

  it("clamps out-of-range scores, ignores unknown ids, skips malformed lines", async () => {
    const three = [...candidates, scored("c", "AI chips", 0.5)];
    const s = fakeSummarizer(
      [
        'scoreItem("zzz", 0.99, "not in the candidate set")',
        "scoreItem(b, , )", // malformed — skipped
        'scoreItem("a", -5, "way below range")',
        'scoreItem("c", 42, "way above range")',
      ].join("\n")
    );
    const out = await agenticRerank(three, interests, s);
    // c clamps to 1, a clamps to 0; b was never scored → stays behind both.
    expect(ids(out)).toEqual(["c", "a", "b"]);
  });

  it("keeps unscored items in their original relative order, after scored ones", async () => {
    const three = [...candidates, scored("c", "AI chips", 0.5)];
    const s = fakeSummarizer('scoreItem("c", 0.6, "on topic")');
    expect(ids(await agenticRerank(three, interests, s))).toEqual(["c", "a", "b"]);
  });

  it("passes single-item input straight through", async () => {
    const one = [scored("a", "Only one", 0.5)];
    const s: Summarizer = {
      summarize: async () => {
        throw new Error("must not be called");
      },
    };
    expect(ids(await agenticRerank(one, interests, s))).toEqual(["a"]);
  });
});

describe("createWebLLMSummarizer", () => {
  // In Node there is no navigator.gpu, so isWebGPUAvailable() is false and the
  // function must reject before ever attempting the dynamic import.
  it("rejects when WebGPU is unavailable", async () => {
    await expect(createWebLLMSummarizer()).rejects.toThrow(/WebGPU is not available/);
  });
});
