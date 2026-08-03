import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchInitialPages, fetchRemainingPages, type FeedFailure } from "./lib/rss";
import {
  personalize,
  toggleTopic,
  type PersonalizationProfile,
  type SortMode,
} from "./lib/personalize";
import { loadProfile, saveProfile } from "./lib/personalization-profile";
import {
  collectTopics,
  mergeCatalog,
  searchTopics,
  TOPIC_LIMIT,
  type TopicOption,
} from "./lib/topics";
import { mockSummarizer, isWebGPUAvailable, getMemoryInfo, type Summarizer } from "./lib/summarizer";
import type { FeedItem } from "./lib/types";

// Minimal UI. The start screen is a picker over the topics the sources
// themselves publish (<category> tags, pooled across feeds); the chosen topics
// drive the local, deterministic ranking in personalize(). Each card shows
// title + full text + an LLM summary (mockSummarizer by default).
//
// The feed arrives in stages (first page of every source, then the rest). Every
// arrival is merged into one collection and the selected sort is applied to the
// whole collection, so Relevant and Latest keep their meaning while pages load.

// Strip HTML to plain text for display/summarization.
function toPlainText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Adds freshly loaded items, keeping only the first occurrence of every id. */
function appendItems(current: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const known = new Set(current.map((item) => item.id));
  const fresh = incoming.filter((item) => {
    if (known.has(item.id)) return false;
    known.add(item.id);
    return true;
  });
  return fresh.length ? [...current, ...fresh] : current;
}

function Card({ item, summarizer }: { item: FeedItem; summarizer: Summarizer }) {
  const fullText = useMemo(() => toPlainText(item.content), [item.content]);
  const [summary, setSummary] = useState<string>("…");

  useEffect(() => {
    let alive = true;
    summarizer.summarize(fullText).then((s) => {
      if (alive) setSummary(s);
    });
    return () => {
      alive = false;
    };
  }, [fullText, summarizer]);

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

      <details className="card__full">
        <summary>Full text</summary>
        <p>{fullText}</p>
      </details>
    </li>
  );
}

function TopicSetup({
  catalog,
  topics,
  loading,
  onSave,
  onSkip,
}: {
  catalog: TopicOption[];
  topics: string[];
  loading: boolean;
  onSave: (topics: string[]) => void;
  onSkip: () => void;
}) {
  // Local until saved, so an abandoned pick never touches the stored profile.
  const [selected, setSelected] = useState<string[]>(topics);
  const [query, setQuery] = useState("");

  // The chips are the frequent topics plus whatever is already selected — a
  // chosen topic must stay visible even when it is not in the top of the list.
  const chips = useMemo(() => {
    const top = catalog.slice(0, TOPIC_LIMIT);
    const shown = new Set(top.map((option) => option.topic));
    const extra = catalog.filter(
      (option) => selected.includes(option.topic) && !shown.has(option.topic)
    );
    return [...top, ...extra];
  }, [catalog, selected]);

  const suggestions = useMemo(
    () => searchTopics(catalog, query, chips.map((option) => option.topic)),
    [catalog, query, chips]
  );

  const choose = (topic: string) =>
    setSelected((current) => toggleTopic(current, topic));

  return (
    <section className="setup">
      <h2 className="setup__title">What do you want to read about?</h2>
      <p className="setup__hint">
        The {TOPIC_LIMIT} most common topics across your feeds. Pick any number, or
        search for a rarer one — they stay in this browser.
      </p>

      {loading && <p className="setup__state">Loading topics…</p>}
      {!loading && !chips.length && (
        <p className="setup__state">No topics found in the feeds — continue with a plain feed.</p>
      )}

      <ul className="setup__topics" hidden={loading}>
        {chips.map((option) => {
          const isSelected = selected.includes(option.topic);
          return (
            <li key={option.topic}>
              <button
                type="button"
                className={`topic-chip${isSelected ? " is-selected" : ""}`}
                aria-pressed={isSelected}
                onClick={() => choose(option.topic)}
              >
                {option.label}
                <span className="topic-chip__count">{option.count}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="setup__search" hidden={loading}>
        <input
          className="setup__search-input"
          type="search"
          value={query}
          aria-label="Search topics"
          placeholder="Search other topics…"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && !suggestions.length && (
          <p className="setup__state">No other topic matches “{query}”.</p>
        )}
        {suggestions.length > 0 && (
          <ul className="setup__suggestions">
            {suggestions.map((option) => (
              <li key={option.topic}>
                <button
                  type="button"
                  className="setup__suggestion"
                  onClick={() => {
                    choose(option.topic);
                    setQuery("");
                  }}
                >
                  {option.label}
                  <span className="topic-chip__count">{option.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="setup__actions">
        <button className="setup__save" type="button" onClick={() => onSave(selected)}>
          Save {selected.length ? `(${selected.length})` : ""}
        </button>
        <button className="setup__skip" type="button" onClick={onSkip}>
          Skip
        </button>
      </div>
    </section>
  );
}

function SortSwitch({
  mode,
  hasTopics,
  onChange,
}: {
  mode: SortMode;
  hasTopics: boolean;
  onChange: (mode: SortMode) => void;
}) {
  return (
    <div className="sort" role="group" aria-label="Sort feed">
      <button
        type="button"
        className={`sort__option${mode === "relevant" ? " is-selected" : ""}`}
        aria-pressed={mode === "relevant"}
        onClick={() => onChange("relevant")}
      >
        Relevant
      </button>
      <button
        type="button"
        className={`sort__option${mode === "latest" ? " is-selected" : ""}`}
        aria-pressed={mode === "latest"}
        onClick={() => onChange("latest")}
      >
        Latest
      </button>
      {!hasTopics && (
        <span className="sort__hint">pick topics to make “Relevant” differ</span>
      )}
    </div>
  );
}

export function App() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [failures, setFailures] = useState<FeedFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The React state is the source of truth; localStorage is persistence only.
  // Hydrated once, before the first paint, so setup does not flash for a
  // returning reader.
  const [profile, setProfile] = useState<PersonalizationProfile>(loadProfile);

  const commitProfile = useCallback((next: PersonalizationProfile) => {
    setProfile(next);
    saveProfile(next);
  }, []);

  useEffect(() => {
    let alive = true;

    fetchInitialPages()
      .then((load) => {
        if (!alive) return undefined;
        setItems(load.items);
        setCatalog(collectTopics(load.items, Number.POSITIVE_INFINITY));
        setFailures(load.failures);
        setLoading(false);
        return fetchRemainingPages((items) => {
          if (alive) setItems((current) => appendItems(current, items));
        }, load.successfulSources);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
          setLoadingMore(false);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  // The picker offers what the sources publish, and keeps improving while pages
  // stream in. Merging keeps every chip where it already was — only the counts
  // change, and newly discovered topics are appended — so nothing moves out from
  // under the reader's finger.
  const [catalog, setCatalog] = useState<TopicOption[]>([]);
  useEffect(() => {
    const next = collectTopics(items, Number.POSITIVE_INFINITY);
    // The first catalogue is frequency-ranked. Later pages update counts and
    // append discoveries without moving chips the reader may already target.
    setCatalog((shown) => (shown.length ? mergeCatalog(shown, next) : next));
  }, [items]);

  const feed = useMemo(() => personalize(items, profile), [items, profile]);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Vibe Feed</h1>
        <span className="app__hint">
          WebGPU: {isWebGPUAvailable() ? "available" : "not available (mock LLM)"}
          {(() => {
            const { deviceMemoryGb, usedJsHeapMb } = getMemoryInfo();
            const parts: string[] = [];
            if (deviceMemoryGb !== undefined) parts.push(`~${deviceMemoryGb} GB RAM`);
            if (usedJsHeapMb !== undefined) parts.push(`${usedJsHeapMb} MB used`);
            return parts.length ? ` · ${parts.join(" · ")}` : "";
          })()}
        </span>
      </header>

      {error && <p className="app__state app__state--error">{error}</p>}
      {/* A dead source is reported but never empties the feed. */}
      {failures.map((failure) => (
        <p key={failure.sourceId} className="app__state app__state--warning">
          {failure.sourceTitle} unavailable: {failure.error}
        </p>
      ))}

      {!profile.setupCompleted ? (
        <TopicSetup
          catalog={catalog}
          topics={profile.topics}
          // First-page topics are usable immediately; archive discoveries and
          // counts merge in place while the reader chooses.
          loading={loading}
          onSave={(topics) => commitProfile({ ...profile, setupCompleted: true, topics })}
          onSkip={() => commitProfile({ ...profile, setupCompleted: true })}
        />
      ) : (
        <>
          <section className="interests">
            <span className="interests__label">My interests:</span>
            <span className="interests__value">
              {profile.topics.length ? profile.topics.join(", ") : "(none yet — cold start)"}
            </span>
            <button
              type="button"
              className="interests__edit"
              // Reopening setup is a view state, not an accepted change: the
              // stored profile is left untouched until Save or Skip.
              onClick={() => setProfile({ ...profile, setupCompleted: false })}
            >
              Edit topics
            </button>
          </section>

          <SortSwitch
            mode={profile.sortMode}
            hasTopics={profile.topics.length > 0}
            onChange={(sortMode) => commitProfile({ ...profile, sortMode })}
          />

          {loading && <p className="app__state">Loading feeds…</p>}

          <ul className="feed">
            {feed.map((item) => (
              <Card key={item.id} item={item} summarizer={mockSummarizer} />
            ))}
          </ul>

          {!loading && loadingMore && (
            <p className="app__state feed__more">Loading more articles…</p>
          )}
        </>
      )}
    </main>
  );
}
