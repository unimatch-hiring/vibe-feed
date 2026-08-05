# Vibe Feed

[![CI](https://github.com/unimatch-hiring/vibe-feed/actions/workflows/ci.yml/badge.svg)](https://github.com/unimatch-hiring/vibe-feed/actions/workflows/ci.yml)

**Live demo:** https://unimatch-hiring.github.io/vibe-feed/
**Play with the ranking:** https://unimatch-hiring.github.io/vibe-feed/how-it-works.html

A news feed that puts the articles you care about on top. Everything runs in your
browser. There is no server.

## What it does

You type what you're into — say `rust, webgpu`. Matching articles move to the top.
You press 👍 or 👎 on cards and the order gets better.

Open the demo. Works immediately, no setup, no API key.

## Run it

```bash
npm ci
npm run dev    # → http://localhost:5173/vibe-feed/
npm test       # 130 tests
npm run build
```

Vite + React + TypeScript. No backend.

## Why this repo exists

This was the sandbox for our vibe-coding interviews: 80 minutes to turn a flat list
of headlines into a personalized feed. We've stopped using it that way, so instead
of leaving an empty scaffold we finished the exercise and left the result in `main`.
It's not "the correct answer" — it's one way to do it, explained below.

## The pipeline

```
1. fetch      pull articles from RSS and Atom feeds
2. dedupe     same story on two sites → keep one card
3. embed      turn each article into a list of numbers
4. score      compare those numbers, sort the feed
5. rerank     OPTIONAL: let an LLM fix the top of the list
```

Steps 1–4 are plain arithmetic. No model downloads, no API keys, no network beyond
the feeds. Step 5 is a bonus — switch it off and the feed still works.

---

# How the ranking works

Three ideas. Each one fits on paper, and there's an
[interactive version](https://unimatch-hiring.github.io/vibe-feed/how-it-works.html)
where you can drag the vectors around and watch the numbers move.

## Idea 1 — a text becomes a list of numbers

First, fix a **vocabulary**: the words we care about, in a fixed order. Say our
entire vocabulary is three words:

```
position 1 → "rust"
position 2 → "gpu"
position 3 → "cake"
```

Now any text becomes three numbers — count how many times each vocabulary word
shows up:

```
text: "rust and gpu"

  position 1  "rust"  appears 1 time   → 1
  position 2  "gpu"   appears 1 time   → 1
  position 3  "cake"  appears 0 times  → 0

  vector = [1, 1, 0]
```

The word `and` is not counted — it's not in the vocabulary. That's on purpose:
words like "and", "the", "is" carry no subject matter, so real systems drop them
(they're called stop words).

A few more:

```
"rust rust rust gpu"   →  [3, 1, 0]     rust ×3, gpu ×1, cake ×0
"cake recipes"         →  [0, 0, 1]     only cake matched
"hello world"          →  [0, 0, 0]     nothing matched
```

The order never changes: slot 1 is *always* rust, slot 2 is *always* gpu. That's the
only reason two vectors can be compared at all — you're comparing like with like.

Real code uses **8192 slots** instead of 3, and hashes each word into a slot number
instead of keeping a dictionary.

## Idea 2 — similarity is an angle

Think of each vector as an **arrow starting at zero**. Ignore `cake` for a moment,
so there are only two directions: `rust` to the right, `gpu` upward.

- A = `[1, 1, 0]` — one step right, one step up. Points diagonally, at 45°.
- B = `[3, 1, 0]` — three steps right, one step up. Points mostly right, tilted up
  a little.

Both arrows lean up-and-right. The **angle between them is small** — and that's the
point: both texts are about the same two subjects, B just says "rust" more often.

That angle is the measurement, and it's called **cosine similarity**:

| cosine | means | example |
|---|---|---|
| 1.0 | same direction | a text compared with itself |
| 0.89 | almost the same | our A and B |
| 0.0 | perpendicular | A vs `[0,0,1]` "cake" — no shared words |
| −1.0 | opposite | nothing in a word-count vector reaches this |

**Why the angle and not the distance between the two arrow tips?** Because distance
would mostly measure length, and length just means "longer text". A 3000-word
article and a one-line link about the same thing should score the same. Using the
angle throws length away for free.

If you'd rather see this than read it, the
[interactive page](https://unimatch-hiring.github.io/vibe-feed/how-it-works.html)
lets you drag an arrow around and watch the angle and the number change together.

## Idea 3 — your profile is an average

Take every article you 👍 and average their vectors. That average — the **centroid**
— is your taste. Do the same for 👎 and subtract it:

```
profile = average(liked) − 0.5 × average(disliked)
```

Worked example, same three-word vocabulary:

```
👍 "rust and gpu"     [1, 1, 0]
👍 "rust tricks"      [1, 0, 0]
👎 "cake recipes"     [0, 0, 1]


average(liked)      = [ (1+1)/2, (1+0)/2, (0+0)/2 ]  = [1.0, 0.5, 0.0]
average(disliked)   =                                  [0.0, 0.0, 1.0]

profile = [1.0, 0.5, 0.0]  −  0.5 × [0.0, 0.0, 1.0]

        = [ 1.0 ,  0.5 , −0.5 ]
            ↑      ↑      ↑
          rust    gpu    cake
          high  medium   negative → actively pushed down
```

Then score every article by its cosine against that profile and sort. That's the
ranker, end to end.

**The good part:** one 👍 moves the profile immediately. Nothing gets trained,
nothing is uploaded, no server involved. This trick is from 1971 — it's called
Rocchio relevance feedback — and plenty of production systems still use it, because
nothing cheaper works this well.

## The final score

Similarity alone would happily show you a great article from two years ago, so we
mix in two more signals:

| part | weight | what it does |
|---|---|---|
| semantic | 0.65 | how close to your profile |
| recency | 0.25 | newer wins, half-life 48 hours |
| feedback | 0.10 | you voted on this one explicitly |

## Where this breaks

**1. Averaging two unrelated interests points at nothing.**

```
   gpu
     │
     │  ● webgpu article
     │
     │       ★  ← your profile: the average of the two
     │
     │              ● rust article
     └────────────────────────────→ rust

   You liked one webgpu article and one rust article.
   The average lands between them — close to neither.
   A new article about ONLY rust scores medium, not high.
```

The average of two peaks is the valley between them.

**2. It can't tell *what* from *how*.**

```
   "Guide: how to structure a Rust service"     ← tutorial
   "Why we restructured our Rust service"       ← the essay you wanted

   Same words. Same subject. Vectors sit right next to each other.
   Cosine sees no difference at all.
```

You asked for discussions, not tutorials. That distinction lives in **intent**, not
vocabulary — so no amount of better embeddings fixes it.

**So: arithmetic sorts the feed, the LLM edits the top of it.** The LLM only sees the
top ~10 articles, never all 200 — which is exactly what makes a small model in a
browser tab realistic.

## Three engines, pick one in the UI

| Engine | What it is | Key | Network |
|---|---|---|---|
| **Mock** | Instant, canned summaries. Default. | no | no |
| **On-device** | Qwen2.5-0.5B in your browser (WebLLM + WebGPU). ~945 MB downloaded once, then offline. | no | first run |
| **Cloud** | Gemini or Claude, called from the page. | yours | yes |

Why three? **WebGPU is missing on a lot of machines**, and not everyone has an API
key — requiring either would break the app for those people. Sorting works
identically on all three; only summaries and reranking change. You lose quality
going down the list, never features.

**About API keys.** You type it into the page. It's saved in your browser
(`localStorage`) and sent only to Google or Anthropic. It's not in this repo and
can't be — there's no server here to hide it behind. If that's not acceptable, stay
on Mock or On-device.

## Where things live

| File | What's in it |
|---|---|
| `src/lib/embed.ts` | Text → vector. Cosine, centroid. |
| `src/lib/personalize.ts` | Builds your profile, dedupes, sorts. |
| `src/lib/agent.ts` | The optional LLM rerank. |
| `src/lib/summarizer.ts` | Switches between the three engines. |
| `src/lib/cloud.ts` | Calls Gemini / Claude. |
| `src/lib/rss.ts` | Reads RSS and Atom. One broken feed doesn't kill the rest. |
| `src/lib/feeds.ts` | The source list. |
| `src/lib/storage.ts` | Saves interests, votes and your API key — `localStorage`. |
| `src/lib/types.ts` | `FeedItem` and `ScoredItem` — the shapes everything else passes around. |
| `public/mock-feed.xml` | Local feed. Has a duplicate article on purpose, so you can watch dedupe work. |

Longer write-up with measurements: [`docs/spec-personalized-feed.md`](docs/spec-personalized-feed.md).

## What's not great

- **~6 MB bundle.** The browser-LLM runtime is heavy; the scaffold was 200 KB. Drop
  the on-device engine and most of it goes away.
- **Only Latin letters get ranked.** We split text on `[^a-z0-9]+`, so Russian,
  Chinese and Japanese end up with empty vectors. Known, not fixed.
- **Our vectors are dumber than a real embedding model.** They don't know "GPU" and
  "CUDA" are related — hashing can't. A real sentence model is ~25 MB before the
  first result, and a tier that only works after a successful fetch isn't a floor.
- **Dedupe only catches near-identical titles.** Reworded reposts get through.
- **Some feeds can't be read from a browser at all.** Hacker News, Lobsters and The
  Verge send no CORS headers. There's an opt-in checkbox to route them through a
  public proxy, off by default. As of 2026-08-04 most free proxies were dead or
  rate-limited, so that checkbox may just skip those sources.

---

## The other approach: let an agent decide

Everything above is **deterministic**: we chose the pipeline, the weights, the
thresholds. Same input, same output, forever.

You could build this differently — hand an agent SDK the goal and the raw material,
and let it pick the method:

> "Here are 6 RSS feeds and this user's likes. Build me a personalized feed. Decide
> yourself how to score, dedupe and order it."

You specify the **outcome**, not the **method**. Ask twice and you may get two
different plans: one run clusters by topic and drops the food cluster, another
scores every article 0–10 and notices some are tutorials. Neither plan was specified
by us — that's what "the model decides" means, and it's why the same request doesn't
guarantee the same feed.

| | Cosine + centroid | Agent |
|---|---|---|
| Who picks the method | you, up front | the model, at runtime |
| Same input → same output | always | not guaranteed |
| Cost and latency | ~0, milliseconds | model calls, seconds |
| Works offline | yes | no |
| Understands intent ("not tutorials") | no | yes |

Neither is better — they **fail differently**. The arithmetic is blind to intent; the
agent is unpredictable and costs money on every refresh. That's why this repo keeps
the arithmetic as a guaranteed floor and puts the model on top as an upgrade.

If you swap in an agentic ranker, the things worth measuring are in
[`docs/spec-personalized-feed.md`](docs/spec-personalized-feed.md): run-to-run
stability, precision against a hand-labelled set, cost per refresh, and what happens
when the network dies.

## Learn more

Practical, with pictures and things to click:

- [Google ML Crash Course — Embeddings](https://developers.google.com/machine-learning/crash-course/embeddings)
  — interactive, beginner-first, kept up to date.
- [The Illustrated Word2vec](https://jalammar.github.io/illustrated-word2vec/) — Jay
  Alammar explains vectors and cosine entirely through diagrams.
- [TensorFlow Embedding Projector](https://projector.tensorflow.org/) — rotate real
  embeddings in 3D in your browser.
- [Pinecone: vector similarity](https://www.pinecone.io/learn/vector-similarity/) —
  how this gets used in production search.

The original sources, if you want the derivations:

- [Introduction to Information Retrieval](https://nlp.stanford.edu/IR-book/information-retrieval-book.html)
  (Manning, Raghavan, Schütze — free). Ch. 6 is vectors and cosine, ch. 9 §9.1.1 is
  Rocchio.
- [Feature Hashing for Large Scale Multitask Learning](https://arxiv.org/abs/0902.2206)
  — the hashing trick, with the proof that collisions mostly don't matter.
