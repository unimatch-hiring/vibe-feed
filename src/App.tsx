import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchAllFeedsDetailed } from "./lib/rss";
import { PROXIES } from "./lib/feeds";
import { ModelPicker } from "./ModelPicker";
import {
  rankFeed,
  explainScore,
  SCORE_DECIMALS,
  type UserInterests,
} from "./lib/personalize";
import {
  loadInterests,
  saveInterests,
  loadCloudConfig,
  saveCloudConfig,
} from "./lib/storage";
import {
  mockSummarizer,
  isWebGPUAvailable,
  getMemoryInfo,
  createWebLLMSummarizer,
  WEBLLM_MODEL,
  WEBLLM_MODELS,
  type Summarizer,
  type EngineStatus,
} from "./lib/summarizer";
import {
  createCloudSummarizer,
  verifyCloudKey,
  GEMINI_MODEL,
  CLAUDE_MODEL,
  type CloudProvider,
} from "./lib/cloud";
import { agenticRerank } from "./lib/agent";
import type { FeedItem, ScoredItem } from "./lib/types";

// Named in the proxy disclosure below — derived so the copy can't drift from the
// hosts actually contacted.
const PROXY_HOSTS = PROXIES.map((proxy) => new URL(proxy.prefix).host);

// Model weights read as download size to the user, so show GB past ~1 GB.
function formatWeight(mb: number): string {
  return mb >= 1024 ? `~${(mb / 1024).toFixed(1)} GB` : `~${mb} MB`;
}

// Debounce for the free-text topics input, so ranking doesn't rerun per keystroke.
const TOPICS_DEBOUNCE_MS = 300;

// Suggested starter topics — solves cold start for a reviewer in one click.
const STARTER_TOPICS = ["webgpu", "llm summarization", "rss", "offline caching", "cors"];

// How many top-ranked items the "AI rerank" action considers.
const RERANK_TOP_N = 10;

// Which LLM backs summaries and the agentic rerank. Mutually exclusive; "mock"
// is the default and the fallback the other two degrade to.
type EngineMode = "mock" | "ondevice" | "cloud";

const CLOUD_MODEL_LABEL: Record<CloudProvider, string> = {
  gemini: `Gemini (${GEMINI_MODEL})`,
  claude: `Claude (${CLAUDE_MODEL})`,
};

const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = {
  gemini: "Google Gemini",
  claude: "Anthropic Claude",
};

// Wraps a cloud summarizer so a failed call degrades to the mock instead of
// leaving a card stuck on "…". Same non-negotiable rule as the WebLLM path: the
// engine may improve the feed, never break it.
function withMockFallback(inner: Summarizer, onError: (message: string) => void): Summarizer {
  return {
    async summarize(text: string): Promise<string> {
      try {
        return await inner.summarize(text);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
        return mockSummarizer.summarize(text);
      }
    },
  };
}

// Strip HTML to plain text for display/summarization. Entities have to be
// decoded too, not just tags dropped — feeds ship `&amp;` / `&rsquo;` inside
// text nodes, and stripping tags alone leaves them visible to the reader.
function toPlainText(html: string): string {
  const stripped = html.replace(/<[^>]*>/g, " ");
  const doc = new DOMParser().parseFromString(stripped, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function parseTopics(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function Card({
  scored,
  summarizer,
  liked,
  disliked,
  onLike,
  onDislike,
}: {
  scored: ScoredItem;
  summarizer: Summarizer;
  liked: boolean;
  disliked: boolean;
  onLike: () => void;
  onDislike: () => void;
}) {
  const item = scored.item;
  const fullText = useMemo(() => toPlainText(item.content), [item.content]);
  const [summary, setSummary] = useState<string>("…");
  const [showMath, setShowMath] = useState(false);
  const mathId = useId();

  useEffect(() => {
    let alive = true;
    summarizer.summarize(fullText).then((s) => {
      if (alive) setSummary(s);
    });
    return () => {
      alive = false;
    };
  }, [fullText, summarizer]);

  const dupCount = scored.duplicates.length;
  // The card and the panel must quote the same number, so both read the breakdown
  // total rather than the raw score.
  const breakdown = useMemo(() => explainScore(scored), [scored]);

  return (
    <li className="card">
      <a className="card__title" href={item.link} target="_blank" rel="noreferrer">
        {item.title}
      </a>
      <div className="card__meta">{item.sourceTitle}</div>

      <div className="card__summary">
        <span className="card__summary-label">Summary</span>
        {summary}
      </div>

      <div className="card__rank">
        <button
          type="button"
          className="card__rank-why"
          aria-expanded={showMath}
          aria-controls={mathId}
          onClick={() => setShowMath((v) => !v)}
        >
          {scored.why}
          <span className="card__rank-toggle" aria-hidden="true">
            {showMath ? "hide math" : "show math"}
          </span>
        </button>
        <span className="card__rank-score">
          {breakdown.total.toFixed(SCORE_DECIMALS)}
        </span>
      </div>

      {showMath && (
        <dl className="math" id={mathId}>
          {breakdown.terms.map((term) => (
            <div className="math__row" key={term.label}>
              <dt className="math__label">{term.label}</dt>
              <dd className="math__calc">
                <span className="math__raw">{term.raw.toFixed(SCORE_DECIMALS)}</span>
                <span className="math__op">×</span>
                <span className="math__weight">{term.weight.toFixed(SCORE_DECIMALS)}</span>
                <span className="math__op">=</span>
                <span className="math__value">
                  {term.contribution.toFixed(SCORE_DECIMALS)}
                </span>
              </dd>
            </div>
          ))}
          <div className="math__row math__row--total">
            <dt className="math__label">score</dt>
            <dd className="math__calc">
              <span className="math__value">{breakdown.total.toFixed(SCORE_DECIMALS)}</span>
            </dd>
          </div>
          <p className="math__note">
            Weights are fixed: what you're interested in counts for most, how fresh it
            is breaks ties, a 👍 or 👎 nudges from there.
          </p>
        </dl>
      )}

      {dupCount > 0 && (
        <div className="card__dupes">
          +{dupCount} duplicate{dupCount === 1 ? "" : "s"} collapsed
          {" — "}
          {scored.duplicates.map((d) => d.sourceTitle).join(", ")}
        </div>
      )}

      <div className="card__actions">
        <button
          type="button"
          className={`card__vote card__vote--up${liked ? " card__vote--active" : ""}`}
          aria-pressed={liked}
          onClick={onLike}
        >
          👍
        </button>
        <button
          type="button"
          className={`card__vote card__vote--down${disliked ? " card__vote--active" : ""}`}
          aria-pressed={disliked}
          onClick={onDislike}
        >
          👎
        </button>
      </div>

      <details className="card__full">
        <summary>Full text</summary>
        <p>{fullText}</p>
      </details>
    </li>
  );
}

export function App() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchErrors, setFetchErrors] = useState<string[]>([]);
  const [errorsDismissed, setErrorsDismissed] = useState(false);

  // Interest model. Lazy init so localStorage is read exactly once.
  const [interests, setInterests] = useState<UserInterests>(() => loadInterests());
  const [topicsText, setTopicsText] = useState<string>(() => interests.topics.join(", "));
  const debounceRef = useRef<number | undefined>(undefined);

  // Engine state for the on-device summarizer.
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("idle");
  const [engineProgress, setEngineProgress] = useState<{ pct: number; text: string }>({
    pct: 0,
    text: "",
  });
  const [engineError, setEngineError] = useState<string | null>(null);
  const [summarizer, setSummarizer] = useState<Summarizer>(mockSummarizer);
  const [onDeviceModelId, setOnDeviceModelId] = useState<string>(WEBLLM_MODEL);

  // Cloud engine. Lazy init so localStorage is read exactly once; a key stored
  // from a previous session restores the cloud engine without re-verifying (the
  // user can still press "Use this key" to re-check it).
  const storedCloud = useState(() => loadCloudConfig())[0];
  const [engineMode, setEngineMode] = useState<EngineMode>(storedCloud ? "cloud" : "mock");
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(
    storedCloud?.provider ?? "gemini"
  );
  const [cloudKeyInput, setCloudKeyInput] = useState<string>(storedCloud?.apiKey ?? "");
  // Non-null once a key is in use for this session (restored or freshly verified).
  const [activeCloudProvider, setActiveCloudProvider] = useState<CloudProvider | null>(
    storedCloud?.provider ?? null
  );
  const [cloudVerifying, setCloudVerifying] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<string | null>(
    storedCloud ? "using the key saved in this browser (not re-verified)" : null
  );
  const [cloudError, setCloudError] = useState<string | null>(null);

  // "AI rerank top 10" state.
  const [reranking, setReranking] = useState(false);
  const [rerankNote, setRerankNote] = useState<string | null>(null);
  const [rerankedOrder, setRerankedOrder] = useState<string[] | null>(null);

  // Opt-in to the extra proxy-only sources. React state only (not persisted), so
  // it stays off by default on every load and doesn't touch storage.ts keys.
  const [useProxy, setUseProxy] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchAllFeedsDetailed({ useProxy })
      .then(({ items, errors }) => {
        setItems(items);
        setFetchErrors(errors);
        setErrorsDismissed(false);
      })
      .catch((e) => setFetchErrors([String(e)]))
      .finally(() => setLoading(false));
  }, [useProxy]);

  const ranked = useMemo(() => rankFeed(items, interests), [items, interests]);

  // Apply an AI-rerank result (if any) on top of the heuristic order: reordered
  // items first (in the model's order), everything else follows unchanged.
  const feed = useMemo(() => {
    if (!rerankedOrder) return ranked;
    const byId = new Map(ranked.map((s) => [s.item.id, s]));
    const front = rerankedOrder.map((id) => byId.get(id)).filter((s): s is ScoredItem => !!s);
    const frontIds = new Set(rerankedOrder);
    const rest = ranked.filter((s) => !frontIds.has(s.item.id));
    return [...front, ...rest];
  }, [ranked, rerankedOrder]);

  // A new heuristic ranking (feed refetch, interests change) invalidates any
  // previous AI rerank — it was computed over a different top-10.
  useEffect(() => {
    setRerankedOrder(null);
    setRerankNote(null);
  }, [ranked]);

  function updateInterests(next: UserInterests) {
    setInterests(next);
    saveInterests(next);
  }

  function onTopicsTextChange(text: string) {
    setTopicsText(text);
    if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      updateInterests({ ...interests, topics: parseTopics(text) });
    }, TOPICS_DEBOUNCE_MS);
  }

  function toggleStarterTopic(topic: string) {
    const current = parseTopics(topicsText);
    const active = current.includes(topic);
    const next = active ? current.filter((t) => t !== topic) : [...current, topic];
    setTopicsText(next.join(", "));
    if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    updateInterests({ ...interests, topics: next });
  }

  function toggleLike(id: string) {
    const liked = interests.liked.includes(id);
    updateInterests({
      ...interests,
      liked: liked ? interests.liked.filter((x) => x !== id) : [...interests.liked, id],
      disliked: interests.disliked.filter((x) => x !== id),
    });
  }

  function toggleDislike(id: string) {
    const disliked = interests.disliked.includes(id);
    updateInterests({
      ...interests,
      disliked: disliked ? interests.disliked.filter((x) => x !== id) : [...interests.disliked, id],
      liked: interests.liked.filter((x) => x !== id),
    });
  }

  // A restored cloud key is wired up on mount, so cards summarize through it
  // right away rather than waiting for the user to press anything.
  useEffect(() => {
    if (!storedCloud) return;
    setSummarizer(
      withMockFallback(createCloudSummarizer(storedCloud), (msg) => setCloudError(msg))
    );
  }, [storedCloud]);

  async function enableOnDeviceLlm() {
    const modelId = onDeviceModelId;
    setEngineMode("ondevice");
    setEngineStatus("loading");
    setEngineError(null);
    setEngineProgress({ pct: 0, text: "" });
    try {
      const engine = await createWebLLMSummarizer(
        (pct, text) => setEngineProgress({ pct, text }),
        modelId
      );
      setSummarizer(engine);
      setEngineStatus("ready");
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err));
      setEngineStatus("error");
      // Keep the mock summarizer — the feed must never break.
      setSummarizer(mockSummarizer);
    }
  }

  // A loaded engine is bound to its weights, so switching model means downloading
  // again. Drop back to the mock and make the user opt into that explicitly
  // rather than silently pulling gigabytes on a dropdown change.
  function selectOnDeviceModel(modelId: string) {
    setOnDeviceModelId(modelId);
    if (engineStatus === "ready" || engineStatus === "error") {
      setEngineStatus("idle");
      setEngineError(null);
      setSummarizer(mockSummarizer);
    }
  }

  function selectMode(mode: EngineMode) {
    setEngineMode(mode);
    setCloudError(null);

    if (mode === "mock") {
      setSummarizer(mockSummarizer);
      return;
    }
    if (mode === "cloud") {
      // Re-arm the cloud engine if a verified key is already in hand.
      if (activeCloudProvider && cloudKeyInput) {
        setSummarizer(
          withMockFallback(
            createCloudSummarizer({ provider: activeCloudProvider, apiKey: cloudKeyInput }),
            (msg) => setCloudError(msg)
          )
        );
      } else {
        setSummarizer(mockSummarizer);
      }
      return;
    }
    // "ondevice": reuse the loaded engine if there is one, otherwise the user
    // still has to press "Enable on-device LLM" (it's a big download).
    if (engineStatus !== "ready") setSummarizer(mockSummarizer);
  }

  async function useCloudKey() {
    const apiKey = cloudKeyInput.trim();
    setCloudVerifying(true);
    setCloudError(null);
    setCloudStatus(null);
    try {
      const config = { provider: cloudProvider, apiKey };
      const result = await verifyCloudKey(config);
      if (!result.ok) {
        setActiveCloudProvider(null);
        setCloudError(result.error ?? "The key could not be verified.");
        setSummarizer(mockSummarizer); // stay on the always-works engine
        return;
      }
      saveCloudConfig(config);
      setActiveCloudProvider(cloudProvider);
      setCloudStatus("key verified — cloud engine active");
      setSummarizer(withMockFallback(createCloudSummarizer(config), (msg) => setCloudError(msg)));
      setEngineMode("cloud");
    } finally {
      setCloudVerifying(false);
    }
  }

  function forgetCloudKey() {
    saveCloudConfig(null);
    setCloudKeyInput("");
    setActiveCloudProvider(null);
    setCloudStatus(null);
    setCloudError(null);
    setSummarizer(mockSummarizer);
    setEngineMode("mock");
  }

  async function runAgenticRerank() {
    setReranking(true);
    setRerankNote(null);
    try {
      const top = feed.slice(0, RERANK_TOP_N);
      const result = await agenticRerank(top, interests, summarizer);
      const sameOrder =
        result.length === top.length && result.every((s, i) => s.item.id === top[i].item.id);
      if (sameOrder) {
        setRerankNote("order unchanged");
        setRerankedOrder(null);
      } else {
        setRerankedOrder(result.map((s) => s.item.id));
        setRerankNote(`reordered by the ${cloudReady ? "cloud" : "on-device"} model`);
      }
    } finally {
      setReranking(false);
    }
  }

  const { deviceMemoryGb, usedJsHeapMb } = getMemoryInfo();
  const webgpuAvailable = isWebGPUAvailable();
  const activeTopics = parseTopics(topicsText);

  const cloudReady = engineMode === "cloud" && activeCloudProvider !== null;
  const onDeviceReady = engineMode === "ondevice" && engineStatus === "ready";
  // The rerank only needs *a* Summarizer, so either real engine unlocks it.
  const llmReady = cloudReady || onDeviceReady;

  const onDeviceModel =
    WEBLLM_MODELS.find((model) => model.id === onDeviceModelId) ?? WEBLLM_MODELS[0];

  const activeEngineLabel = cloudReady
    ? `Cloud · ${CLOUD_MODEL_LABEL[activeCloudProvider]}`
    : onDeviceReady
      ? `On-device · ${onDeviceModelId}`
      : "Mock (offline)";

  return (
    <main className="app">
      <header className="app__header">
        <div className="app__header-top">
          <h1>Vibe Feed</h1>
          <span className="app__hint">
            WebGPU: {webgpuAvailable ? "available" : "not available (mock LLM)"}
            {(() => {
              const parts: string[] = [];
              if (deviceMemoryGb !== undefined) parts.push(`~${deviceMemoryGb} GB RAM`);
              if (usedJsHeapMb !== undefined) parts.push(`${usedJsHeapMb} MB used`);
              return parts.length ? ` · ${parts.join(" · ")}` : "";
            })()}
          </span>
        </div>

        {/* Static page, so it must go through BASE_URL like any other public asset. */}
        <a className="app__explain" href={`${import.meta.env.BASE_URL}how-it-works.html`}>
          How the ranking works — play with it →
        </a>

        <div className="engine">
          <div className="engine__row">
            <span className="engine__status">
              Engine: <strong>{activeEngineLabel}</strong>
            </span>
          </div>

          <div className="engine__modes" role="radiogroup" aria-label="LLM engine">
            {(
              [
                ["mock", "Mock (offline)"],
                ["ondevice", "On-device"],
                ["cloud", "Cloud"],
              ] as Array<[EngineMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={engineMode === mode}
                className={`engine__mode${engineMode === mode ? " engine__mode--active" : ""}`}
                onClick={() => selectMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          {engineMode === "mock" && (
            <p className="engine__note">
              Deterministic, instant, no network and no key — the default. Embedding-based ranking
              works fully on this engine; only the LLM rerank needs a real model.
            </p>
          )}

          {engineMode === "ondevice" && (
            <>
              <div className="engine__row">
                <span className="engine__status">
                  On-device status: <strong>{engineStatus}</strong>
                </span>
                <button
                  type="button"
                  className="engine__button"
                  disabled={
                    !webgpuAvailable || engineStatus === "loading" || engineStatus === "ready"
                  }
                  onClick={enableOnDeviceLlm}
                >
                  {engineStatus === "ready" ? "Enabled" : "Enable on-device LLM"}
                </button>
              </div>

              {!webgpuAvailable && (
                <p className="engine__note">
                  WebGPU isn't available in this browser, so the mock summarizer is in use — it's
                  deterministic and instant, not a real model.
                </p>
              )}

              {webgpuAvailable && (
                <div className="engine__model">
                  <span className="engine__field-label" id="ondevice-model-label">
                    Model
                  </span>
                  <ModelPicker
                    models={WEBLLM_MODELS}
                    value={onDeviceModelId}
                    disabled={engineStatus === "loading"}
                    onChange={selectOnDeviceModel}
                    formatWeight={formatWeight}
                    labelId="ondevice-model-label"
                  />
                </div>
              )}

              {webgpuAvailable && engineStatus === "idle" && (
                <p className="engine__note">
                  Downloads <code>{onDeviceModelId}</code> once ({formatWeight(onDeviceModel.vramMb)},
                  cached after the first run) and summarizes in-browser instead of with the mock.
                  Bigger models read better and must still fit in GPU memory — hence the smallest
                  by default.
                </p>
              )}

              {engineStatus === "loading" && (
                <div className="engine__progress">
                  <div className="engine__progress-bar">
                    <div
                      className="engine__progress-fill"
                      style={{ width: `${engineProgress.pct}%` }}
                    />
                  </div>
                  <span className="engine__progress-text">
                    {engineProgress.pct}% {engineProgress.text}
                  </span>
                </div>
              )}

              {engineStatus === "error" && engineError && (
                <p className="engine__note engine__note--error">
                  On-device model failed to load: {engineError} Falling back to the mock summarizer.
                </p>
              )}
            </>
          )}

          {engineMode === "cloud" && (
            <div className="engine__cloud">
              <div className="engine__cloud-providers" role="radiogroup" aria-label="Cloud provider">
                {(["gemini", "claude"] as CloudProvider[]).map((p) => (
                  <label key={p} className="engine__radio">
                    <input
                      type="radio"
                      name="cloud-provider"
                      value={p}
                      checked={cloudProvider === p}
                      onChange={() => setCloudProvider(p)}
                    />
                    {CLOUD_PROVIDER_LABEL[p]}{" "}
                    <code>{p === "gemini" ? GEMINI_MODEL : CLAUDE_MODEL}</code>
                  </label>
                ))}
              </div>

              <div className="engine__cloud-key">
                <label className="engine__field-label" htmlFor="cloud-key-input">
                  API key
                </label>
                <input
                  id="cloud-key-input"
                  className="engine__cloud-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={cloudKeyInput}
                  placeholder={
                    cloudProvider === "gemini" ? "Google AI Studio key" : "Anthropic API key"
                  }
                  onChange={(e) => setCloudKeyInput(e.target.value)}
                />
                <button
                  type="button"
                  className="engine__button"
                  disabled={cloudVerifying || cloudKeyInput.trim().length === 0}
                  onClick={useCloudKey}
                >
                  {cloudVerifying ? "Verifying…" : "Use this key"}
                </button>
                <button
                  type="button"
                  className="engine__button"
                  disabled={cloudVerifying || (!activeCloudProvider && !cloudKeyInput)}
                  onClick={forgetCloudKey}
                >
                  Forget key
                </button>
              </div>

              {cloudStatus && <p className="engine__note">{cloudStatus}</p>}

              {cloudError && (
                <p className="engine__note engine__note--error">
                  Cloud call failed: {cloudError} Summaries fall back to the mock summarizer, so the
                  feed keeps working.
                </p>
              )}

              <p className="engine__note engine__note--warn">
                <strong>Where your key goes.</strong> It is stored in this browser's{" "}
                <code>localStorage</code> and sent <strong>directly from this browser</strong> to{" "}
                {cloudProvider === "gemini" ? "Google's" : "Anthropic's"} API. There is no backend
                here: the key is never sent anywhere else, never leaves your machine except to the
                provider, and is never committed to the repo. Requests are billed to that key, so
                using a key with billing attached is at your own risk — prefer a scoped,
                revocable, low-limit key. "Forget key" erases it from state and{" "}
                <code>localStorage</code>.
                {cloudProvider === "claude" && (
                  <>
                    {" "}
                    Claude also requires the{" "}
                    <code>anthropic-dangerous-direct-browser-access</code> header, i.e. calling
                    Anthropic straight from a browser page is something you are explicitly opting
                    into — the key is exposed to anything running on this page.
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </header>

      <section className="interests">
        <label className="interests__label" htmlFor="topics-input">
          My interests (comma-separated):
        </label>
        <input
          id="topics-input"
          className="interests__input"
          type="text"
          value={topicsText}
          placeholder="e.g. webgpu, rust, distributed systems"
          onChange={(e) => onTopicsTextChange(e.target.value)}
        />

        <div className="interests__chips">
          {STARTER_TOPICS.map((topic) => {
            const active = activeTopics.includes(topic);
            return (
              <button
                key={topic}
                type="button"
                className={`chip${active ? " chip--active" : ""}`}
                aria-pressed={active}
                onClick={() => toggleStarterTopic(topic)}
              >
                {topic}
              </button>
            );
          })}
        </div>

        {activeTopics.length === 0 && (
          <p className="interests__cold-start">
            (none yet — cold start, feed falls back to newest-first)
          </p>
        )}
      </section>

      <section className="sources">
        <label className="sources__toggle">
          <input
            type="checkbox"
            checked={useProxy}
            onChange={(e) => setUseProxy(e.target.checked)}
          />
          Load extra sources via CORS proxy (HN, Lobsters, The Verge)
        </label>
        <p className="sources__note">
          Off by default: these sites send no CORS headers, so enabling this routes three requests
          through <code>{PROXY_HOSTS[0]}</code> — a third party that will see them. Free proxies die
          often, so {PROXY_HOSTS.slice(1).join(" and ")} are tried after it. If all miss, those
          sources drop out as errors and the rest of the feed is unaffected.
        </p>
      </section>

      <section className="rerank">
        {llmReady && (
          <button type="button" className="rerank__button" disabled={reranking} onClick={runAgenticRerank}>
            {reranking ? "Reranking…" : "AI rerank top 10"}
          </button>
        )}
        {rerankNote && <span className="rerank__note">{rerankNote}</span>}
      </section>

      {loading && <p className="app__state">Loading feeds…</p>}

      {fetchErrors.length > 0 && !errorsDismissed && (
        <div className="app__errors">
          <div className="app__errors-header">
            <span>{fetchErrors.length} source{fetchErrors.length === 1 ? "" : "s"} failed to load</span>
            <button type="button" className="app__errors-dismiss" onClick={() => setErrorsDismissed(true)}>
              dismiss
            </button>
          </div>
          <ul className="app__errors-list">
            {fetchErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <ul className="feed">
        {feed.map((scored) => (
          <Card
            key={scored.item.id}
            scored={scored}
            summarizer={summarizer}
            liked={interests.liked.includes(scored.item.id)}
            disliked={interests.disliked.includes(scored.item.id)}
            onLike={() => toggleLike(scored.item.id)}
            onDislike={() => toggleDislike(scored.item.id)}
          />
        ))}
      </ul>
    </main>
  );
}
