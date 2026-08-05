import { describe, expect, it } from "vitest";
import { EMBED_DIM, centroid, cosine, embed } from "./embed";

function l2(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function isAllZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

describe("embed", () => {
  it("is deterministic", () => {
    const a = embed("hello world");
    const b = embed("hello world");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("has dimension EMBED_DIM and unit L2 norm for non-empty text", () => {
    const v = embed("machine learning inference on edge devices");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
    expect(l2(v)).toBeCloseTo(1, 5);
  });

  it("is self-similar", () => {
    const t = "retrieval augmented generation with vector databases";
    expect(cosine(embed(t), embed(t))).toBeCloseTo(1, 5);
  });

  it("ranks related text above unrelated text", () => {
    const a = "small language models are good enough for summarization";
    const related = "compact LLMs can summarize short articles well";
    const unrelated = "sourdough bread baking hydration and starter maintenance";

    const simRelated = cosine(embed(a), embed(related));
    const simUnrelated = cosine(embed(a), embed(unrelated));

    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simUnrelated).toBeLessThan(0.2);
    // Measured: related 0.231, unrelated 0.070. Tightened past the required 0.2 so
    // a regression in shingle noise filtering fails here instead of passing quietly.
    expect(simUnrelated).toBeLessThan(0.12);
    expect(simRelated - simUnrelated).toBeGreaterThan(0.1);
  });

  it("matches shared word stems across different inflections", () => {
    // The reason shingles exist: no synonym list, yet these must score as related.
    expect(
      cosine(embed("summarization of long documents"), embed("summarize documents"))
    ).toBeGreaterThan(0.5);
    expect(
      cosine(embed("quantized model inference"), embed("quantization for inference"))
    ).toBeGreaterThan(0.5);
  });

  it("keeps unrelated topics near-orthogonal", () => {
    const topics = [
      "kubernetes operators reconcile desired cluster state",
      "sourdough bread baking hydration and starter maintenance",
      "premier league transfer window january signings",
      "mortgage interest rates and the central bank decision",
      "wooden furniture restoration with shellac french polish",
    ].map(embed);

    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        expect(cosine(topics[i], topics[j])).toBeLessThan(0.2);
      }
    }
  });

  it("keeps one-word queries near-orthogonal to unrelated text across many words", () => {
    // Blocker: a bare chip like "rss" or "cors" occupies a single bucket, so ONE
    // hash collision with any of an article's ~400 features makes the similarity
    // pure noise. Whether a given pair collides is luck, so assert on the rate over
    // many words rather than one hand-picked pair (which passes even at 256).
    // Measured noise rate over these pairs: 34% at EMBED_DIM=256, 7.5% at 1024,
    // 0% at 4096 and 8192. The bucket space must keep that near zero.
    const words = [
      "rss", "cors", "webgpu", "llm", "cache", "proxy", "gpu", "feed", "model",
      "browser", "offline", "token", "vector", "index", "shader", "quantize",
      "latency", "parser", "worker", "socket", "kernel", "tensor", "schema",
      "cursor", "buffer", "stream", "thread", "packet", "digest", "cipher",
    ];
    const unrelated = [
      "sourdough bread baking hydration and starter maintenance overnight",
      "premier league transfer window january signings and loan deals",
      "wooden furniture restoration with shellac and french polish technique",
      "mortgage interest rates and the central bank rate decision this quarter",
    ].map(embed);

    let noisy = 0;
    for (const word of words) {
      const v = embed(word);
      for (const doc of unrelated) {
        if (Math.abs(cosine(v, doc)) > 0.05) noisy++;
      }
    }
    expect(noisy / (words.length * unrelated.length)).toBeLessThan(0.05);
  });

  it("strips HTML tags", () => {
    const html =
      "<div class='post'><h1>Vector search</h1><p>Approximate nearest " +
      "neighbour indexes make <b>semantic</b> retrieval fast.</p></div>";
    const plain =
      "Vector search Approximate nearest neighbour indexes make semantic retrieval fast.";
    expect(cosine(embed(html), embed(plain))).toBeGreaterThan(0.9);
  });

  it("returns an all-zero vector for empty input", () => {
    const v = embed("");
    expect(v.length).toBe(EMBED_DIM);
    expect(isAllZero(v)).toBe(true);
  });

  it("returns an all-zero vector for stopword-only input", () => {
    expect(isAllZero(embed("the and for that with this are was"))).toBe(true);
  });

  it("returns exactly 0 (not NaN) when one side is empty", () => {
    const s = cosine(embed(""), embed("anything at all goes here"));
    expect(s).toBe(0);
    expect(Number.isNaN(s)).toBe(false);
  });
});

describe("cosine", () => {
  it("returns 0 for a zero vector, never NaN", () => {
    const zero = new Float32Array(EMBED_DIM);
    const v = embed("quantized transformers run locally in the browser");
    expect(cosine(zero, v)).toBe(0);
    expect(cosine(v, zero)).toBe(0);
    expect(cosine(zero, zero)).toBe(0);
  });

  it("does not assume normalized inputs", () => {
    const v = embed("edge inference latency budget");
    const scaled = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) scaled[i] = v[i] * 7.5;
    expect(cosine(v, scaled)).toBeCloseTo(1, 5);
  });

  it("is symmetric and bounded", () => {
    const a = embed("distributed systems consensus protocols");
    const b = embed("olive oil harvest in andalusia");
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 6);
    expect(cosine(a, b)).toBeLessThanOrEqual(1.000001);
    expect(cosine(a, b)).toBeGreaterThanOrEqual(-1.000001);
  });
});

describe("centroid", () => {
  it("returns an all-zero vector for an empty list", () => {
    const c = centroid([]);
    expect(c.length).toBe(EMBED_DIM);
    expect(isAllZero(c)).toBe(true);
  });

  it("returns the same direction for a single vector", () => {
    const v = embed("kubernetes operators reconcile desired state");
    const c = centroid([v]);
    expect(cosine(c, v)).toBeCloseTo(1, 5);
    expect(l2(c)).toBeCloseTo(1, 5);
  });

  it("returns an all-zero vector when the mean cancels out", () => {
    const v = embed("anything");
    const neg = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) neg[i] = -v[i];
    expect(isAllZero(centroid([v, neg]))).toBe(true);
  });

  it("sits closer to its members than they are to an unrelated vector", () => {
    const a = embed("open weight language models for on-device inference");
    const b = embed("running quantized LLMs locally without a datacenter");
    const unrelated = embed("wooden furniture restoration and shellac finishes");

    const c = centroid([a, b]);
    expect(cosine(c, a)).toBeGreaterThan(cosine(a, unrelated));
    expect(cosine(c, b)).toBeGreaterThan(cosine(b, unrelated));
    expect(cosine(c, a)).toBeGreaterThan(cosine(c, unrelated));
  });
});
