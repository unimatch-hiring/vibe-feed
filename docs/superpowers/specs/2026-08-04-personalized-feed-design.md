# Vibe Feed — personalized client-side feed (design)

## Goal

Turn the chronological list into a personalized feed. Everything runs in the
browser. No hardcoded keyword rules as the ranking mechanism.

## Approaches considered

**A. Keyword / rule scoring.** `if (title.includes("react")) score += 5`.
Instant and dependency-free, but it is exactly the deterministic noodle the
task warns against: no generalization, every new interest needs new code.
Rejected as the primary mechanism.

**B. LLM-only ranking (WebLLM).** Genuinely smart, but weights are hundreds of
MB, WebGPU is absent on many machines (Safari, no-GPU CI), and per-item
inference over 25 items is slow. `CLAUDE.md` explicitly requires the app to
stay useful without a real model, so this cannot be the only path.

**C. Embedding vectors + cosine similarity.** Semantic (matches "LLM" to
"language model" without either word being enumerated), fast enough to rank the
whole feed every keystroke, no GPU needed. Needs an embedder; a real
transformer embedder is not installed and cannot be fetched offline.

**Chosen: C as the always-on baseline, B as a detected upgrade tier.**

## Architecture — three tiers, capability-detected

Ranking is a pipeline: `fetch → dedup → embed → score → (optional LLM rerank)`.

**Tier 0 — semantic vector baseline (always on, no GPU, no network).**
A hashing-trick embedder written by hand: tokenize → subword shingles → seeded
hash into a fixed-width dense vector → L2 normalize. Interests and articles map
into the same space, and relevance is cosine similarity. This is a real
vector-space model, not enumerated rules: adding an interest requires no code
change, and related wording scores as related via shared shingles. Deterministic
and unit-testable, which is why it is also the tier the tests pin.

**Tier 1 — on-device LLM rerank (opt-in, WebGPU only).**
`@mlc-ai/web-llm` (already in optionalDependencies, present in node_modules).
Model: `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` — smallest MLC prebuilt that follows
instructions, ~300 MB cached in IndexedDB by WebLLM itself. Used for two things:
real abstractive summaries behind the existing `Summarizer` interface, and an
**agentic reranker** — the model is handed a tool (`scoreItem`) and decides the
ordering of the top-N candidates, rather than us writing the comparison.
Never blocks first paint; the feed is already ranked by Tier 0 when it loads.

**Tier 2 — feedback loop (always on).**
Like / dislike per card nudges the interest vector toward or away from that
article's vector (Rocchio-style centroid update). This is what makes the feed
*personalized* rather than merely *filtered*: the model of the reader is learned
from behavior, not only typed in. Persisted to localStorage.

### Why the hand-rolled embedder rather than a dependency

`@xenova/transformers` would give better vectors, but it is not installed and
this environment cannot be assumed online. A tier that only works when a
download succeeds is not a baseline. The hashing embedder has no such
dependency, so the "always works" promise is real.

## Scoring

```
score = w_sem * cosine(interests, item) + w_recency * recency + w_feedback * fb
```

Recency is an exponential decay with a ~48 h half-life, so a highly relevant
older item can outrank a fresh irrelevant one — the fix for the firehose
problem the mock feed itself describes.

## Dedup

The mock feed carries an intentional cross-post: same story, different link,
different wording. Exact-link dedup misses it. Dedup therefore runs on
**content similarity** — near-duplicate if title-vector cosine is above a
threshold — collapsing the pair and keeping the earlier/more complete one.

## Scaffold bugs to fix (found while reading)

1. `feeds.ts` points at `/mock-feed.xml` while `vite.config.ts` sets
   `base: "/vibe-feed/"` → 404 in dev and in build. Must resolve against
   `import.meta.env.BASE_URL`.
2. `rss.ts` uses `Promise.all` → one dead network source empties the feed.
   Must isolate per source (`allSettled`).
3. Parser is RSS-2.0-only → Atom `<entry>` feeds parse as empty. Must handle both.

## Error handling

Every tier degrades: no WebGPU → Tier 0 only, labeled in the UI. Feed source
fails → other sources still render, failures surfaced non-fatally. Model fails
to load → mock summarizer, feed unaffected.

## Testing

Vitest, pure functions. Cover: embedder determinism and similarity ordering,
cosine, recency decay, dedup collapsing the known cross-post, feedback moving
rank in the right direction, ranking stability, URL resolution against base,
Atom parsing, per-source failure isolation. The existing two test files must
keep passing in spirit (the `personalize` stub test changes by design — it
asserts the stub behavior we are replacing).
