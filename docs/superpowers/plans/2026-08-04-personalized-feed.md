# Personalized Feed Implementation Plan

> **For agentic workers:** implement task-by-task, TDD. Steps use `- [ ]`.

**Goal:** Turn the chronological RSS list into a personalized, deduped,
semantically ranked client-side feed with an optional on-device LLM tier.

**Architecture:** `fetch → dedup → embed → score → optional LLM rerank`.
Tier 0 = hand-rolled hashing embedder + cosine (always works, no GPU).
Tier 1 = WebLLM (`Qwen2.5-0.5B-Instruct-q4f16_1-MLC`) for summaries + agentic
rerank. Tier 2 = like/dislike feedback updating the interest vector.

**Tech Stack:** Vite + React 19 + TypeScript, Vitest, `@mlc-ai/web-llm`
(optional dep, already in node_modules).

## Global Constraints

- No new npm dependencies. Only what is already installed.
- The app MUST work with no WebGPU and no network beyond the local mock.
- Type-check is part of build (`tsc -b`) — no `any` leaks, no unused vars
  (`noUnusedLocals`/`noUnusedParameters` are on).
- Match existing code style: named exports, 2-space indent, comments only where
  non-obvious.
- All feed URLs must resolve against `import.meta.env.BASE_URL`.
- Vitest runs in Node: no `window`/`navigator`/`DOMParser` at module top level
  in anything a test imports. Guard browser APIs behind `typeof` checks.

---

## LOCKED INTERFACES — do not rename, other tasks depend on these verbatim

`src/lib/embed.ts`
```ts
export const EMBED_DIM = 256;
export function embed(text: string): Float32Array;      // L2-normalized
export function cosine(a: Float32Array, b: Float32Array): number;
export function centroid(vectors: Float32Array[]): Float32Array; // normalized; zero vec if empty
```

`src/lib/types.ts` (additions — keep existing FeedItem fields unchanged)
```ts
export interface ScoredItem {
  item: FeedItem;
  score: number;
  semantic: number;
  recency: number;
  feedback: number;
  duplicates: FeedItem[];   // collapsed near-duplicates, [] if none
  why: string;              // short human-readable reason
}
```

`src/lib/personalize.ts`
```ts
export interface UserInterests {
  topics: string[];
  liked: string[];    // FeedItem.id
  disliked: string[]; // FeedItem.id
}
export const EMPTY_INTERESTS: UserInterests;   // { topics: [], liked: [], disliked: [] }
export function interestVector(interests: UserInterests, items: FeedItem[]): Float32Array;
export function dedupe(items: FeedItem[]): { kept: FeedItem[]; collapsed: Map<string, FeedItem[]> };
export function recencyScore(publishedAt: number, now: number): number; // 0..1, 48h half-life
export function rankFeed(items: FeedItem[], interests: UserInterests, now?: number): ScoredItem[];
export function personalize(items: FeedItem[], interests: UserInterests): FeedItem[]; // kept: rankFeed().map(s => s.item)
```

`src/lib/summarizer.ts` (keep all existing exports as-is, add)
```ts
export type EngineStatus = "idle" | "loading" | "ready" | "error" | "unsupported";
export function createWebLLMSummarizer(
  onProgress?: (pct: number, text: string) => void
): Promise<Summarizer>;
export const WEBLLM_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
```

`src/lib/agent.ts`
```ts
export interface RerankTools {
  scoreItem(id: string, score: number, reason: string): void;
}
export async function agenticRerank(
  candidates: ScoredItem[],
  interests: UserInterests,
  summarizer: Summarizer
): Promise<ScoredItem[]>;
```

`src/lib/storage.ts`
```ts
export function loadInterests(): UserInterests;   // EMPTY_INTERESTS if absent/corrupt
export function saveInterests(i: UserInterests): void;
```

---

### Task 1: Fix scaffold bugs in rss.ts / feeds.ts

**Files:** Modify `src/lib/feeds.ts`, `src/lib/rss.ts`; Create `src/lib/rss.test.ts`

- [ ] Write failing tests: `resolveFeedUrl("/mock-feed.xml")` prefixes BASE_URL
      without doubling slashes and leaves `https://` URLs untouched;
      `parseFeedXml` parses both RSS `<item>` and Atom `<entry>`;
      `fetchAllFeeds` returns items from healthy sources when one source rejects.
- [ ] Export `resolveFeedUrl(url: string): string` from `feeds.ts` and
      `parseFeedXml(text: string, source: FeedSource): FeedItem[]` from `rss.ts`
      so both are testable without a browser. Parse via `DOMParser` when
      available; tests may inject/skip accordingly — do NOT reference DOMParser
      at module top level.
- [ ] Switch `fetchAllFeeds` to `Promise.allSettled`, keep successes, and export
      `fetchAllFeedsDetailed(): Promise<{ items: FeedItem[]; errors: string[] }>`.
      Keep `fetchAllFeeds` working for back-compat.
- [ ] Atom: map `<entry>` → title, `link[href]`, `content`/`summary`, `updated`/`published`.
- [ ] Run `npx vitest run src/lib/rss.test.ts` → PASS.

### Task 2: Embedder (`embed.ts`)

**Files:** Create `src/lib/embed.ts`, `src/lib/embed.test.ts`

- [ ] Write failing tests first:
      determinism (same text → identical vector); L2 norm ≈ 1; identical texts
      cosine ≈ 1; topically related texts ("language model summarization" vs
      "small LLMs summarize text") score higher than unrelated ("sourdough bread
      baking"); empty string → all-zero vector, cosine with anything = 0 (no NaN);
      `centroid([])` → zero vector.
- [ ] Implement: lowercase, strip HTML/punctuation, split on non-letters/digits,
      drop a small stopword set, emit both whole tokens and 4-char character
      shingles of tokens longer than 5 (this is what gives morphological
      generalization). Hash each feature with FNV-1a into `EMBED_DIM` buckets,
      accumulate with sign from a second hash bit (signed hashing trick), weight
      by `1/sqrt(termFrequency)` damping, then L2-normalize.
- [ ] `cosine` must return 0 when either vector is zero-length. No NaN ever.
- [ ] Run tests → PASS.

### Task 3: Ranking (`personalize.ts`) + storage

**Files:** Modify `src/lib/personalize.ts`, `src/lib/types.ts`;
Create `src/lib/storage.ts`, `src/lib/personalize.test.ts` (replace existing),
`src/lib/storage.test.ts`

**Interfaces:** consumes `embed`, `cosine`, `centroid` from Task 2 verbatim.

- [ ] Write failing tests: `recencyScore(now, now) === 1` and decays to ≈0.5 at
      48 h and monotonically decreases; `dedupe` collapses the two "client-side
      news reader" cross-posts into one kept item with one entry in `collapsed`,
      and does NOT collapse genuinely different articles; `rankFeed` with
      `topics: ["webgpu"]` ranks the WebGPU article first; an item in `liked`
      raises its own rank vs. the same feed without the like; `disliked` lowers
      it; `rankFeed([], …)` → `[]`; `personalize` returns the same items as
      `rankFeed(...).map(s => s.item)`; storage round-trips and returns
      `EMPTY_INTERESTS` on corrupt JSON.
- [ ] Implement `interestVector`: centroid of embedded topic strings and embedded
      liked items, minus 0.5 × centroid of disliked item vectors, renormalized.
- [ ] Implement `dedupe` on cosine of `embed(title)` ≥ 0.82, keeping the item
      with longer `content`; record collapsed ones.
- [ ] Implement `rankFeed`: dedupe → embed each item (`title + " " + content`
      truncated to 2000 chars) → `score = 0.65*semantic + 0.25*recency +
      0.10*feedback`, where cold start (zero interest vector) falls back to
      recency-dominant ordering so the feed is never arbitrary. Fill `why` with a
      short string like `"matches your interests (0.42) · 3h ago"`.
- [ ] `storage.ts` guards `typeof localStorage === "undefined"`.
- [ ] Run tests → PASS.

### Task 4: WebLLM tier + agentic rerank

**Files:** Modify `src/lib/summarizer.ts`; Create `src/lib/agent.ts`, `src/lib/agent.test.ts`

**Interfaces:** consumes `ScoredItem` (Task 3), `Summarizer` (existing).

- [ ] Implement `createWebLLMSummarizer`: throw if `!isWebGPUAvailable()`;
      `await import("@mlc-ai/web-llm")`; `CreateMLCEngine(WEBLLM_MODEL, {
      initProgressCallback })`; `summarize` sends a short instruct prompt
      (cap input ~1500 chars) and returns trimmed content. Wrap in try/catch and
      surface a useful Error. The dynamic import must stay dynamic so a machine
      without the package still builds.
- [ ] `agent.ts`: build one prompt listing candidate ids + titles + the reader's
      interests, ask the model to call `scoreItem(id, score, reason)` for each,
      parse the tool calls out of the text response (tolerant regex / JSON
      block), apply the scores, and re-sort. On any parse or model failure return
      `candidates` unchanged — the agent may only improve ordering, never break it.
- [ ] Write tests for `agenticRerank` with a **fake `Summarizer`** (no real
      model): a fake returning well-formed `scoreItem(...)` calls reorders as
      instructed; a fake returning garbage returns the input order unchanged; a
      fake that throws returns input order unchanged.
- [ ] Run tests → PASS.

### Task 5: UI

**Files:** Modify `src/App.tsx`, `src/App.css`

**Interfaces:** consumes everything above verbatim.

- [ ] Interests input: free-text comma-separated topics, debounced into state,
      persisted via `storage.ts`, plus a few one-click starter chips.
- [ ] Cards ordered by `rankFeed`. Each card shows the score/`why` line, a
      "collapsed N duplicates" note when `duplicates.length > 0`, and 👍/👎
      buttons that update interests and visibly reorder the feed.
- [ ] Header: WebGPU status + an "Enable on-device LLM" button that calls
      `createWebLLMSummarizer` with a progress bar, disabled and explained when
      unsupported. When ready, cards use the real summarizer and an
      "AI rerank top 10" action calls `agenticRerank`.
- [ ] Non-fatal per-source error line from `fetchAllFeedsDetailed`.
- [ ] Keep it visually consistent with existing App.css tokens.

### Task 6: Verify

- [ ] `npm run build` → clean.
- [ ] `npm test` → all pass.
- [ ] Dev server + curl checks on `/vibe-feed/` and `/vibe-feed/mock-feed.xml`.

## Self-review notes

- Spec coverage: bugs → T1; Tier 0 → T2+T3; dedup → T3; Tier 1 + agent → T4;
  Tier 2 feedback → T3 (logic) + T5 (controls); degradation → T4/T5.
- Type consistency: `ScoredItem` defined once in `types.ts`, consumed by T3/T4/T5;
  `EMBED_DIM`/`embed`/`cosine`/`centroid` fixed in T2 and only consumed later.
- The existing `personalize.test.ts` asserts stub behavior we intentionally
  replace; T3 rewrites that file rather than leaving a contradictory test.
