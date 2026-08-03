// The topic catalogue offered on the start screen.
//
// Topics are not hard-coded: they are the <category> tags published by the
// sources themselves, pooled across every feed, folded to one canonical spelling
// and ranked by how often they occur. The most frequent ones describe what the
// aggregated feed is actually about, which is what the reader picks from.

import {
  isEditorialSection,
  normalizeTopic,
  splitTag,
  tagExpressesTopic,
  topicTokens,
} from "./taxonomy";
import type { FeedItem } from "./types";

export const TOPIC_LIMIT = 20;

export interface TopicOption {
  topic: string; // canonical value, used for storage and matching
  label: string; // the spelling the sources use most, for display
  count: number; // how many articles carry the topic
}

export function collectTopics(items: FeedItem[], limit: number = TOPIC_LIMIT): TopicOption[] {
  // Per canonical topic: total articles, and how often each spelling was used.
  const counts = new Map<string, number>();
  const labels = new Map<string, Map<string, number>>();

  for (const item of items) {
    // One article counts once per topic even if it repeats the tag.
    const seen = new Set<string>();
    for (const raw of item.categories) {
      // A section of a publication says which desk wrote the post, not what it
      // is about, so it is not offered as an interest.
      if (isEditorialSection(raw)) continue;
      for (const topic of splitTag(raw)) {
        if (seen.has(topic)) continue;
        seen.add(topic);

        counts.set(topic, (counts.get(topic) ?? 0) + 1);
        const spellings = labels.get(topic) ?? new Map<string, number>();
        // A tag that named one topic keeps its published spelling; a split one
        // is shown in its own words.
        const label = splitTag(raw).length === 1 ? raw.trim() : topic;
        spellings.set(label, (spellings.get(label) ?? 0) + 1);
        labels.set(topic, spellings);
      }
    }
  }

  // Tag vocabularies differ between sources, so the number on a chip counts the
  // articles the topic would actually rank — the same rule scoreTopics uses —
  // not just the ones spelling the tag exactly like this.
  const tagsPerItem = items.map((item) => item.categories);
  const options: TopicOption[] = [...counts.keys()].map((topic) => {
    const spellings = [...(labels.get(topic) ?? new Map<string, number>())];
    // Show the wording the sources use most; ties go to the alphabetical one so
    // the label never depends on arrival order.
    spellings.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const words = topicTokens(topic);
    const count = tagsPerItem.filter((tags) =>
      tags.some((tag) => tagExpressesTopic(tag, words))
    ).length;
    return { topic, label: spellings[0]?.[0] ?? topic, count };
  });

  // Deterministic: count descending, then label alphabetically.
  options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return options.slice(0, Math.max(0, limit));
}

/**
 * Folds a freshly computed catalogue into the one already on screen. Topics keep
 * the position they were first shown at and only their counts change; topics
 * that appear later are appended. A picker that reorders while the reader is
 * choosing makes them miss what they aimed at.
 */
export function mergeCatalog(shown: TopicOption[], next: TopicOption[]): TopicOption[] {
  const byTopic = new Map(next.map((option) => [option.topic, option]));
  // A shown topic that the new catalogue no longer offers has become redundant
  // — later pages revealed a broader topic covering it — and is dropped. That
  // removes a chip but never reorders the rest.
  const kept = shown
    .filter((option) => byTopic.has(option.topic))
    .map((option) => byTopic.get(option.topic)!);
  const known = new Set(kept.map((option) => option.topic));
  return [...kept, ...next.filter((option) => !known.has(option.topic))];
}

/**
 * Topics matching what the reader typed, excluding the ones already on screen.
 * This is how a rare tag stays reachable without pushing the top-20 off the
 * start screen: the chips show what the feed is mostly about, the search
 * reaches the long tail.
 */
export function searchTopics(
  options: TopicOption[],
  query: string,
  exclude: string[],
  limit: number = 8
): TopicOption[] {
  const needle = normalizeTopic(query);
  if (!needle) return [];
  const hidden = new Set(exclude);
  return options
    .filter(
      (option) =>
        !hidden.has(option.topic) &&
        (option.topic.includes(needle) || option.label.toLowerCase().includes(needle))
    )
    .slice(0, limit);
}
