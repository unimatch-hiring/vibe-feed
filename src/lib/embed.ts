// Semantic text embedder built on the signed hashing trick ("hashing vectorizer").
//
// Instead of learning a vocabulary, every feature string is hashed straight into
// one of EMBED_DIM buckets. A per-feature sign (+1/-1) from an independent hash
// makes collisions cancel out in expectation rather than pile up, so unrelated
// documents stay near-orthogonal despite the tiny dimension. No model, no
// training data, no vocabulary to ship — works offline and in the browser.

// 8192 buckets. 256 was far too small: a short topic query like "rss" or "cors"
// occupies a single bucket, so a collision with any of an article's ~400 features
// turned the whole similarity into noise. Measured on public/mock-feed.xml at 256,
// topic "webgpu" scored the graceful-degradation article (0.2306) above the WebGPU
// one (0.1590). The vector is sparse and the dot product only touches non-zero
// buckets, so the cost of a bigger space is a Float32Array allocation, not compute.
export const EMBED_DIM = 8192;

// Character n-gram length. 4 is the sweet spot: long enough to carry a morpheme
// ("summ", "mmar"), short enough that "summarize"/"summarization" overlap heavily.
const SHINGLE = 4;

// Only shingle longer tokens — short words are already their own best feature and
// shingling them just adds noise shared by unrelated text.
const MIN_SHINGLE_TOKEN = 6;

const MIN_TOKEN = 3;

// Shingles that are just English inflection/suffix windows. They fire on any long
// word ("summarization" and "hydration" both yield "atio"/"tion"), so they added a
// ~0.12 similarity floor between totally unrelated articles. Dropping them halved
// unrelated similarity (0.13 -> 0.07) and left stem matching slightly better.
const NOISE_SHINGLES = new Set([
  "atio", "tion", "ions", "sion", "ting", "ings", "ment", "ness", "able",
  "ible", "ally", "ical", "ties", "ance", "ence", "ture", "ship", "less",
  "ered", "ette", "rati", "orat", "isti", "ativ", "izin", "isin",
]);

// ~50 high-frequency English words. Kept small on purpose: aggressive stoplists
// throw away topical signal, and the sublinear weighting already tames frequency.
const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "are", "was", "were", "from",
  "have", "has", "had", "not", "but", "you", "your", "its", "they", "them",
  "their", "then", "than", "been", "being", "into", "onto", "over", "more",
  "most", "some", "such", "only", "other", "others", "about", "after", "before",
  "also", "can", "will", "would", "could", "should", "one", "two", "new", "now",
  "out", "how", "why", "what", "when", "where", "which", "who", "whom", "does",
  "did", "doing", "just", "very", "much", "many", "any", "all", "get", "got",
  "here", "there", "these", "those", "our", "his", "her", "him", "she", "used",
  "use", "using", "via", "per", "yet", "own", "too", "may", "might", "must",
]);

const TAG_RE = /<[^>]*>/g;
const NON_WORD_RE = /[^a-z0-9]+/g;

// FNV-1a 32-bit. Two different offset bases give two effectively independent
// hashes of the same string — one picks the bucket, the other picks the sign.
// Deriving both from one hash correlates them and skews the vector.
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const BUCKET_SEED = 0x811c9dc5;
const SIGN_SEED = 0x7fca8b71;

function tokenize(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(TAG_RE, " ")
    .replace(NON_WORD_RE, " ")
    .trim();
  if (cleaned.length === 0) return [];

  const out: string[] = [];
  for (const tok of cleaned.split(/\s+/)) {
    if (tok.length < MIN_TOKEN) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function countFeatures(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  const bump = (f: string): void => {
    tf.set(f, (tf.get(f) ?? 0) + 1);
  };

  for (const tok of tokens) {
    bump(tok);
    if (tok.length >= MIN_SHINGLE_TOKEN) {
      for (let i = 0; i + SHINGLE <= tok.length; i++) {
        const gram = tok.slice(i, i + SHINGLE);
        if (NOISE_SHINGLES.has(gram)) continue;
        bump("#" + gram);
      }
    }
  }
  return tf;
}

function normalizeInPlace(v: Float32Array): Float32Array {
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

/** Embeds text into an L2-normalized vector; all-zero if there is no usable text. */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  if (typeof text !== "string" || text.length === 0) return vec;

  const tf = countFeatures(tokenize(text));

  for (const [feature, count] of tf) {
    // Sublinear damping: a feature repeated 9x counts 3x, not 9x. Added once per
    // distinct feature so long articles don't collapse onto their filler words.
    const weight = 1 / Math.sqrt(count);
    const bucket = fnv1a(feature, BUCKET_SEED) % EMBED_DIM;
    const sign = (fnv1a(feature, SIGN_SEED) & 1) === 1 ? -1 : 1;
    vec[bucket] += sign * weight;
  }

  return normalizeInPlace(vec);
}

/** Cosine similarity. Returns 0 (never NaN) if either vector has zero norm. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  const sim = dot / Math.sqrt(na * nb);
  return Number.isFinite(sim) ? sim : 0;
}

/** Element-wise mean of the vectors, L2-normalized. All-zero for empty input. */
export function centroid(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(EMBED_DIM);
  if (vectors.length === 0) return out;

  for (const v of vectors) {
    const n = Math.min(v.length, EMBED_DIM);
    for (let i = 0; i < n; i++) out[i] += v[i];
  }
  for (let i = 0; i < EMBED_DIM; i++) out[i] /= vectors.length;

  return normalizeInPlace(out);
}
