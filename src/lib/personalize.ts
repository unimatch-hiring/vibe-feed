// Personalization layer: takes the raw aggregated feed and the local profile of
// what the user is interested in, and returns the feed to actually show.
//
// Ranking is deterministic and local: how strongly an article matches the chosen
// topics comes first, then recency, then the original input order. The source
// an article came from is never part of the comparison, so a matching article
// from any feed outranks a non-matching one. Nothing is inferred from passive
// behaviour and nothing leaves the browser.

import { canonicalTopic, tagExpressesTopic, topicTokens } from "./taxonomy";
import type { FeedItem } from "./types";

export { normalizeTopic } from "./taxonomy";

// How the feed is ordered. "relevant" ranks by topic score first, "latest" is
// plain reverse-chronological — an explicit switch, never inferred.
export type SortMode = "relevant" | "latest";

export const SORT_MODES: SortMode[] = ["relevant", "latest"];

// The interest model. `setupCompleted` records that the user has been through
// the topic setup (by choosing topics or skipping it), not that topics exist.
export interface PersonalizationProfile {
  setupCompleted: boolean;
  topics: string[]; // normalized: lowercase, trimmed, de-duplicated
  sortMode: SortMode;
}

export const EMPTY_PROFILE: PersonalizationProfile = {
  setupCompleted: false,
  topics: [],
  sortMode: "relevant",
};

/** Lowercase, trim, drop empties and duplicates — the storage/compare form. */
export function normalizeTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  for (const topic of topics) {
    const normalized = canonicalTopic(topic);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Toggle a topic in the picker selection, keeping the selection normalized. */
export function toggleTopic(topics: string[], topic: string): string[] {
  const normalized = canonicalTopic(topic);
  if (!normalized) return topics;
  return topics.includes(normalized)
    ? topics.filter((existing) => existing !== normalized)
    : [...topics, normalized];
}

// Title plus the opening paragraph — where an article states what it is about.
// Scanning the whole body would make long articles win by length alone.
const LEAD_CHARS = 400;

function leadText(item: FeedItem): string {
  const paragraph = item.content.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  return `${item.title} ${paragraph ?? item.content.slice(0, LEAD_CHARS)}`
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// A published tag is an explicit statement about the article; the same word in
// the body is a weaker hint, so the tag is worth more.
const CATEGORY_WEIGHT = 2;
const TEXT_WEIGHT = 1;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word occurrence, not substring: "ai" must not match "again", "email" or
 * "maintain" — a short topic matching everything is the same as no topic at all.
 */
function mentionsTopic(text: string, topic: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(topic)}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * How strongly the article matches the user's topics: each topic scores once,
 * `CATEGORY_WEIGHT` when it is a published category, `TEXT_WEIGHT` when the word
 * only occurs in the title or body.
 */
export function scoreTopics(item: FeedItem, topics: string[]): number {
  if (!topics.length) return 0;
  const text = leadText(item);
  return topics.reduce((score, topic) => {
    const words = topicTokens(topic);
    if (item.categories.some((tag) => tagExpressesTopic(tag, words))) {
      return score + CATEGORY_WEIGHT;
    }
    if (mentionsTopic(text, topic)) return score + TEXT_WEIGHT;
    return score;
  }, 0);
}

/**
 * Returns a new, stably ordered feed. In "relevant" the topic score outranks
 * recency; in "latest" the score is ignored entirely. The original input
 * position breaks remaining ties, so the same input always produces the same
 * output — the ranking never depends on which fetch answered first.
 */
export function personalize(
  items: FeedItem[],
  profile: PersonalizationProfile
): FeedItem[] {
  const topics = normalizeTopics(profile.topics);
  const useScore = profile.sortMode !== "latest";
  const ranked = items.map((item, index) => ({
    item,
    index,
    score: useScore ? scoreTopics(item, topics) : 0,
  }));

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.publishedAt - a.item.publishedAt ||
      a.index - b.index
  );

  return ranked.map((entry) => entry.item);
}
