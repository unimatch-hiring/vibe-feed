// What a topic *is*, independent of how a particular publisher spells it.
//
// Sources tag their articles with their own vocabularies: dev.to writes "ai",
// The GitHub Blog writes "AI & ML", and neither knows about the other. Comparing
// those strings for equality asks two unrelated editorial teams to have agreed
// on wording, so matching works on the words inside a tag instead.
//
// The curated lists below are deliberately small and explicit. Deriving them
// from the data was tried and does not work at this scale: a real topic
// ("AI & ML", on 40% of GitHub's articles) and an editorial section
// ("News & insights", 14%) are statistically indistinguishable.

/** Lowercase, trim, collapse whitespace — the storage/compare form. */
export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

// Pure spelling variants of the same topic. Not a semantic hierarchy: "llm" is
// deliberately NOT folded into "ai", because a reader may want exactly one.
const ALIASES: Record<string, string> = {
  machinelearning: "machine learning",
  "machine-learning": "machine learning",
  genai: "generative ai",
  opensource: "open source",
  webdev: "web development",
  k8s: "kubernetes",
  js: "javascript",
};

// Sections of a publication, not interests: they say which desk wrote the post.
// Offering them in the picker gives the reader a chip that filters by publisher
// rather than by subject.
const EDITORIAL_SECTIONS = new Set([
  "news",
  "news & insights",
  "company news",
  "changelog",
  "product",
  "announcements",
]);

/** The comparable form of a tag or of what the reader picked. */
export function canonicalTopic(topic: string): string {
  const normalized = normalizeTopic(topic);
  return ALIASES[normalized] ?? normalized;
}

export function isEditorialSection(topic: string): boolean {
  return EDITORIAL_SECTIONS.has(canonicalTopic(topic));
}

/**
 * Splits a published tag into the topics it actually names. "AI & ML" is two
 * interests joined by a conjunction, while "GitHub Copilot" is one compound
 * name — so the split is on connectors only, never on whitespace.
 */
export function splitTag(tag: string): string[] {
  return canonicalTopic(tag)
    .split(/\s*(?:&|,|\/|\band\b)\s*/)
    .map((part) => canonicalTopic(part))
    .filter(Boolean);
}

/** The words of a topic: "machine learning" → ["machine", "learning"]. */
export function topicTokens(topic: string): string[] {
  return canonicalTopic(topic)
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter(Boolean);
}

/**
 * Does a published tag express the reader's topic? True when every word of the
 * topic occurs in the tag, so "ai" matches "AI & ML" and "github copilot"
 * matches "GitHub Copilot CLI" — but "ai" never matches "aim".
 */
export function tagExpressesTopic(tag: string, topicWords: string[]): boolean {
  if (!topicWords.length) return false;
  const tagWords = new Set(topicTokens(tag));
  return topicWords.every((word) => tagWords.has(word));
}
