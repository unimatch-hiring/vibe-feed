// Personalization layer: takes the raw aggregated feed and a model of what the
// user is interested in, and returns the feed to actually show.
//
// Pipeline: dedupe -> embed -> score -> sort. Everything runs locally on the
// hashing embedder from embed.ts — no model, no network, no GPU.

import { centroid, cosine, embed, EMBED_DIM } from "./embed";
import type { FeedItem, ScoredItem } from "./types";

// The interest model: stated topics plus explicit per-item feedback.
export interface UserInterests {
  topics: string[];
  liked: string[];     // FeedItem.id
  disliked: string[];  // FeedItem.id
}

export const EMPTY_INTERESTS: UserInterests = { topics: [], liked: [], disliked: [] };

// Weights: semantic match dominates, recency breaks ties within a topic, explicit
// feedback is a nudge rather than an override (one like shouldn't pin an item
// forever). 0.65 + 0.25 + 0.10 = 1, so score stays in a readable ~[-0.1, 1] range.
export const W_SEMANTIC = 0.65;
export const W_RECENCY = 0.25;
export const W_FEEDBACK = 0.1;

// 48h half-life: a day-old story still competes, a week-old one is background.
export const RECENCY_HALF_LIFE_MS = 48 * 3600_000;

// Dedup cut-off on title similarity. Measured against public/mock-feed.xml: the
// real cross-post pair scores 1.00, the most similar genuinely-distinct pair
// scores 0.19 — so anything in between works. 0.58 keeps headroom for reworded
// syndication (~0.47 per the embedder's own measurements) without merging
// distinct articles.
const DEDUP_THRESHOLD = 0.58;

// How much of the body feeds the item vector. Beyond a couple of thousand chars
// the extra text is boilerplate that dilutes the topical signal.
const CONTENT_CHARS = 2000;

// Title and body are scored SEPARATELY, then blended. Embedding `title + body` as
// one string made the title ~2% of the vector, which inverted relevance: for topic
// "webgpu", cosine against the WebGPU article fell 0.4564 (title only) -> 0.1590
// (title + 2000 body chars), while an article that merely mentions WebGPU in
// passing rose to 0.2306 and won. A title is a human-written topic label, so it is
// the high-precision signal; the body is recall, kept at 0.3 so an on-topic article
// with an off-topic headline can still surface.
const W_TITLE = 0.7;
const W_BODY = 0.3;

// Above this, a card is labelled "matches your interests" instead of "weak match".
// Re-derived after the title/body split rather than inherited. Measured on
// public/mock-feed.xml with the shipped chips, the intended article scores 0.18
// ("cors", "rss" — one-word topics, so only a couple of features to match) up to
// 0.50 ("offline caching"), while every off-topic item stays under 0.09. 0.15 sits
// in that gap and keeps the one-word chips on the positive side of the label.
export const MATCH_THRESHOLD = 0.15;

// Everything the reader sees is quoted to 2 decimals, so the label has to be decided
// on the rounded value too. Comparing the raw number against the threshold while
// printing a rounded one opened a window at 0.145–0.1499: the card showed "(0.15)"
// — visibly the threshold — next to the label for being under it. Rounding first
// costs 0.005 of threshold (the measured gap between on-topic ~0.18 and off-topic
// <0.09 swallows that) and buys the guarantee that no card contradicts its own number.
export const SCORE_DECIMALS = 2;

/** The value the reader is shown — and therefore the one every label is decided on. */
export function displayed(value: number): number {
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(value * factor) / factor;
}

// Disliked topics push the vector away, but at half weight — a dislike says
// "less of this", not "the opposite of this".
const DISLIKE_WEIGHT = 0.5;

/**
 * Builds the user's interest vector: stated topics + liked articles, pushed away
 * from disliked ones. All-zero when there is nothing to go on (cold start).
 *
 * Dislikes alone do NOT make a vector. `-0.5 * neg` points *away* from the only
 * thing we know about, so every article scored against it lands at a negative
 * cosine and the ranking carries no information about what the reader wants — it
 * only says "not that". Returning all-zero routes this to the cold-start path
 * (newest-first, with the -0.1 feedback penalty still demoting the disliked item),
 * which is an honest answer instead of a confidently meaningless order.
 */
export function interestVector(
  interests: UserInterests,
  items: FeedItem[]
): Float32Array {
  const byId = new Map(items.map((i) => [i.id, i]));
  const itemVectors = (ids: string[]): Float32Array[] =>
    ids
      .map((id) => byId.get(id))
      .filter((i): i is FeedItem => i !== undefined)
      .map((i) => embed(itemText(i)));

  const positive = [
    ...interests.topics.filter((t) => t.trim().length > 0).map(embed),
    ...itemVectors(interests.liked),
  ].filter(hasSignal);

  const out = new Float32Array(EMBED_DIM);
  if (positive.length === 0) return out;

  const negative = itemVectors(interests.disliked).filter(hasSignal);
  const pos = centroid(positive);
  const neg = centroid(negative);
  for (let i = 0; i < EMBED_DIM; i++) {
    out[i] = pos[i] - DISLIKE_WEIGHT * neg[i];
  }
  return normalize(out);
}

/**
 * Collapses near-duplicate articles (the same story syndicated by several
 * sources) by title similarity. Keeps the copy with the longest content; the
 * rest land in `collapsed`, keyed by the kept item's id.
 */
export function dedupe(items: FeedItem[]): {
  kept: FeedItem[];
  collapsed: Map<string, FeedItem[]>;
} {
  const kept: FeedItem[] = [];
  const collapsed = new Map<string, FeedItem[]>();
  // Embed each title once — the pairwise scan would otherwise re-embed O(n^2) times.
  const titleVectors = items.map((i) => embed(i.title));
  // Index into `items` of the representative currently kept at kept[k].
  const keptSource: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const match = kept.findIndex(
      (_, k) => cosine(titleVectors[i], titleVectors[keptSource[k]]) >= DEDUP_THRESHOLD
    );

    if (match === -1) {
      kept.push(items[i]);
      keptSource.push(i);
      continue;
    }

    // The longer body wins the slot; the loser is recorded under the winner's id.
    const incumbent = kept[match];
    const [winner, loser] =
      items[i].content.length > incumbent.content.length
        ? [items[i], incumbent]
        : [incumbent, items[i]];

    if (winner !== incumbent) {
      // New representative: move the group (and its key) onto the winner.
      const group = collapsed.get(incumbent.id) ?? [];
      collapsed.delete(incumbent.id);
      kept[match] = winner;
      keptSource[match] = i;
      collapsed.set(winner.id, [...group, loser]);
    } else {
      collapsed.set(winner.id, [...(collapsed.get(winner.id) ?? []), loser]);
    }
  }

  return { kept, collapsed };
}

/**
 * Exponential decay with a 48h half-life: 1 when just published, ~0.5 at 48h,
 * monotonically decreasing, clamped to [0,1].
 *
 * `publishedAt === 0` means the feed's date was unparseable, not "1970". Treating
 * it literally would decay to 0 and bury the item below genuinely stale news, so
 * it gets an explicit floor instead — ranked last among dated items, but present.
 */
export function recencyScore(publishedAt: number, now: number): number {
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) return UNDATED_RECENCY;

  const ageMs = now - publishedAt;
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;

  const score = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

// Low but non-zero, and below the decay value of a month-old item (~0.63%), so an
// undated item sorts behind anything with a real date without falling out of the feed.
const UNDATED_RECENCY = 0.001;

/**
 * Ranks the feed for this reader: dedupe, then score each survivor on semantic
 * match + recency + explicit feedback. Descending by score, stable for ties.
 */
export function rankFeed(
  items: FeedItem[],
  interests: UserInterests,
  now: number = Date.now()
): ScoredItem[] {
  if (items.length === 0) return [];

  const { kept, collapsed } = dedupe(items);
  // Interest vector is built over the full feed: a liked item may itself have
  // been collapsed away, and its text is still valid evidence of taste.
  const iv = interestVector(interests, items);
  const cold = !hasSignal(iv);

  const liked = new Set(interests.liked);
  const disliked = new Set(interests.disliked);

  const scored: ScoredItem[] = kept.map((item) => {
    const semantic = cold ? 0 : similarity(iv, item);
    const recency = recencyScore(item.publishedAt, now);
    const feedback = liked.has(item.id) ? 1 : disliked.has(item.id) ? -1 : 0;

    // At cold start semantic is 0 for everything, so recency is the only real
    // signal. Weighting it by 0.25 would order the feed identically but squash
    // every score under 0.25, which reads as "nothing here matches" in the UI.
    // Giving recency the full weight keeps the displayed score meaningful and
    // makes the newest-first fallback explicit rather than incidental.
    const score = cold
      ? recency + W_FEEDBACK * feedback
      : W_SEMANTIC * semantic + W_RECENCY * recency + W_FEEDBACK * feedback;

    return {
      item,
      score: Number.isFinite(score) ? score : 0,
      semantic,
      recency,
      feedback,
      duplicates: collapsed.get(item.id) ?? [],
      why: explain(semantic, item.publishedAt, now, feedback, cold),
      cold,
    };
  });

  // Sort by index on ties so equal scores keep their input order (Array#sort is
  // spec-stable, but being explicit survives a future comparator change).
  return scored
    .map((s, index) => ({ s, index }))
    .sort((a, b) => b.s.score - a.s.score || a.index - b.index)
    .map(({ s }) => s);
}

/** Ranked feed without the scoring detail. Kept for the existing App.tsx call site. */
export function personalize(
  items: FeedItem[],
  interests: UserInterests
): FeedItem[] {
  return rankFeed(items, interests).map((s) => s.item);
}

/**
 * One line of the score breakdown: a named factor, its weight, and what it
 * contributed. All three are already rounded for display, and `contribution` is the
 * product of the other two as shown — the row is arithmetically true as printed.
 */
export interface ScoreTerm {
  label: string;
  raw: number;
  weight: number;
  contribution: number;
}

/** The breakdown plus the total the rows actually add up to. */
export interface ScoreBreakdown {
  terms: ScoreTerm[];
  /** Sum of the visible contributions — show THIS in the panel, not `scored.score`. */
  total: number;
}

/**
 * The arithmetic behind the score, laid out for the UI — every number already
 * rounded to what the reader will see.
 *
 * Two things are deliberate here.
 *
 * Derived next to the scoring code rather than re-multiplied in the component: the
 * cold-start path weights recency at 1 instead of W_RECENCY, so a breakdown rebuilt
 * from the exported constants would disagree with the number it claims to explain.
 *
 * And rounded ONCE, at the source. Printing `raw.toFixed(2) × weight.toFixed(2) =
 * contribution.toFixed(2)` from raw values produced visible nonsense on ~29% of rows
 * (0.82 × 0.25 shown as 0.20) and a total that missed the sum of its own lines on
 * ~25% of cards. Rounding the factors first, then multiplying those, makes the
 * displayed arithmetic true by construction — `total` is the sum of the visible
 * contributions, so what the panel shows always adds up. It can differ from
 * `scored.score` by a cent; the panel is an explanation, and an explanation that
 * doesn't add up explains nothing.
 */
export function explainScore(scored: ScoredItem): ScoreBreakdown {
  const cold = scored.cold;
  const terms: ScoreTerm[] = [];

  const add = (label: string, raw: number, weight: number) => {
    const r = displayed(raw);
    const w = displayed(weight);
    terms.push({ label, raw: r, weight: w, contribution: displayed(r * w) });
  };

  if (!cold) add("topic match", scored.semantic, W_SEMANTIC);

  // Cold start leans on recency alone, at full weight — hence 1 here, not W_RECENCY.
  add(
    cold ? "freshness (only signal yet)" : "freshness",
    scored.recency,
    cold ? 1 : W_RECENCY
  );

  if (scored.feedback !== 0) {
    add(
      scored.feedback > 0 ? "you liked it" : "you disliked it",
      scored.feedback,
      W_FEEDBACK
    );
  }

  const total = displayed(terms.reduce((sum, t) => sum + t.contribution, 0));
  return { terms, total };
}

function itemText(item: FeedItem): string {
  return `${item.title} ${item.content.slice(0, CONTENT_CHARS)}`;
}

/**
 * Semantic match of one item against the interest vector: title and body scored
 * apart, then blended (see W_TITLE / W_BODY).
 *
 * Negative cosine is compressed rather than clamped to 0. With a dislike in the mix
 * the interest vector can be genuinely opposed to an item, and a hard clamp
 * flattened every such item to exactly 0 — so a dislike could only squash the
 * ranking, never reorder it. Folding negatives into a small band below 0 keeps that
 * ordering (strongly-opposed items sink below merely-unrelated ones) while leaving
 * "0 means unrelated" true, which is what the score shown on each card and the
 * MATCH_THRESHOLD label both read.
 */
function similarity(iv: Float32Array, item: FeedItem): number {
  const title = signedSimilarity(cosine(iv, embed(item.title)));
  const body = signedSimilarity(cosine(iv, embed(item.content.slice(0, CONTENT_CHARS))));
  return W_TITLE * title + W_BODY * body;
}

// Positive cosine passes through unchanged; negatives map into [-NEG_BAND, 0) so
// they still order relative to each other without dominating the final score.
const NEG_BAND = 0.15;

function signedSimilarity(cos: number): number {
  if (!Number.isFinite(cos)) return 0;
  if (cos >= 0) return Math.min(1, cos);
  return Math.max(-1, cos) * NEG_BAND;
}

function hasSignal(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return true;
  return false;
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    v.fill(0);
    return v;
  }
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}

/**
 * Exported for tests only: the semantic score can't be dialled in through rankFeed
 * (it falls out of the embeddings), and the label/number agreement has to be probed
 * right at the rounding boundary.
 */
export function explainForTest(
  semantic: number,
  publishedAt: number,
  now: number,
  feedback = 0,
  cold = false
): string {
  return explain(semantic, publishedAt, now, feedback, cold);
}

function explain(
  semantic: number,
  publishedAt: number,
  now: number,
  feedback: number,
  cold: boolean
): string {
  const parts: string[] = [];

  // A weak match carries no number: below the threshold the cosine rounds to 0.00
  // for most items, and a card reading "weak match (0.00)" looks like the ranking
  // broke rather than like an ordinary off-topic article — that string was in fact
  // the symptom of the clamping bug this module's tests still guard against. The
  // score itself stays visible next to the label, so nothing is hidden.
  // Decided on the rounded value, not the raw one — see `displayed`.
  const shown = displayed(semantic);

  if (cold) parts.push("newest · no interests yet");
  else if (shown >= MATCH_THRESHOLD)
    parts.push(`matches your interests (${shown.toFixed(SCORE_DECIMALS)})`);
  else parts.push("weak match");

  parts.push(formatAge(publishedAt, now));
  if (feedback > 0) parts.push("you liked this");
  else if (feedback < 0) parts.push("you disliked this");

  return parts.join(" · ");
}

function formatAge(publishedAt: number, now: number): string {
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) return "no date";

  const minutes = Math.max(0, Math.round((now - publishedAt) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
