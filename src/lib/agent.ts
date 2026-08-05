// Agentic reranker: instead of hardcoding a comparison, we hand the model a
// tool (`scoreItem`) and let it decide the ordering for this reader.
//
// The only LLM channel is the narrow `Summarizer.summarize()` interface, so the
// "tool call" is text the model writes and we parse back out. That is fragile by
// nature, hence the hard rule below: the agent may only improve the ordering,
// never break the feed. Any failure — throw, garbage, zero usable scores — and
// we return the input untouched.

import type { ScoredItem } from "./types";
import type { UserInterests } from "./personalize";
import type { Summarizer } from "./summarizer";

export interface RerankTools {
  scoreItem(id: string, score: number, reason: string): void;
}

// Keep the prompt small — the on-device model has a tiny context window.
const MAX_CANDIDATES = 20;
const MAX_TITLE_CHARS = 120;

export async function agenticRerank(
  candidates: ScoredItem[],
  interests: UserInterests,
  summarizer: Summarizer
): Promise<ScoredItem[]> {
  if (candidates.length < 2) return candidates;

  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  const byId = new Map(shortlist.map((c) => [c.item.id, c]));

  let raw: string;
  try {
    raw = await summarizer.summarize(buildPrompt(shortlist, interests));
  } catch {
    return candidates;
  }

  const scores = parseToolCalls(raw, byId);
  if (scores.size === 0) return candidates;

  // Scored items first (model's ranking), unscored keep their original relative
  // order behind them — an unscored item means "the model said nothing", not
  // "the model rejected it", so we don't want to interleave it by a guessed value.
  const scored = candidates.filter((c) => scores.has(c.item.id));
  const rest = candidates.filter((c) => !scores.has(c.item.id));

  scored.sort((a, b) => {
    const diff = (scores.get(b.item.id) ?? 0) - (scores.get(a.item.id) ?? 0);
    return diff !== 0 ? diff : b.score - a.score; // tie → keep the heuristic order
  });

  return [...scored, ...rest];
}

function buildPrompt(candidates: ScoredItem[], interests: UserInterests): string {
  const topics = interests.topics.length ? interests.topics.join(", ") : "(none stated)";
  const liked = interests.liked.length ? interests.liked.join(", ") : "(none)";
  const disliked = interests.disliked.length ? interests.disliked.join(", ") : "(none)";

  const lines = candidates
    .map((c) => `${c.item.id} | ${c.item.title.replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS)}`)
    .join("\n");

  return [
    "You rank news articles for one reader.",
    "",
    `Reader's topics: ${topics}`,
    `Articles they liked: ${liked}`,
    `Articles they disliked: ${disliked}`,
    "",
    "Candidates (id | title):",
    lines,
    "",
    "You have one tool:",
    '  scoreItem(id, score, reason)  // score is 0..1, higher = show sooner',
    "",
    "Call scoreItem exactly once per candidate, one call per line, nothing else.",
    "Example:",
    '  scoreItem("some-id", 0.82, "matches their interest in X")',
  ].join("\n");
}

// Tolerant parsing: the model writes text, not structured output. Accept
// scoreItem(...) calls with either quote style and loose whitespace, plus a JSON
// array fallback. Malformed entries are skipped, never fatal.
function parseToolCalls(
  raw: string,
  byId: Map<string, ScoredItem>
): Map<string, number> {
  const out = new Map<string, number>();

  const callRe =
    /scoreItem\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*(-?\d*\.?\d+)\s*(?:,[\s\S]*?)?\)/g;
  for (const m of raw.matchAll(callRe)) {
    add(out, byId, m[2], m[3]);
  }

  if (out.size === 0) {
    for (const entry of parseJsonArray(raw)) {
      add(out, byId, entry.id, entry.score);
    }
  }

  return out;
}

function add(
  out: Map<string, number>,
  byId: Map<string, ScoredItem>,
  id: unknown,
  score: unknown
): void {
  if (typeof id !== "string" || !byId.has(id)) return;
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n)) return;
  out.set(id, Math.min(1, Math.max(0, n)));
}

function parseJsonArray(raw: string): Array<{ id: unknown; score: unknown }> {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((e) => {
    if (typeof e !== "object" || e === null) return [];
    const rec = e as Record<string, unknown>;
    return [{ id: rec.id, score: rec.score }];
  });
}
