// Fetch and parse RSS/Atom directly in the browser.
//
// Loading is two-staged so the reader never waits for the whole archive: the
// first page of every source is fetched in parallel and rendered, then the
// remaining pages stream in. Inside one source the pages are sequential — five
// simultaneous requests to the same host is a burst nobody needs — while the
// sources themselves run in parallel.
//
// Failures are isolated per request: a dead page stops that source's pagination
// only, and a source is reported as failed only when it delivered nothing.
//
// STILL NAIVE: the parser only understands RSS 2.0 (<item>). Atom feeds
// (<entry>) parse as empty.

import { FEEDS, type FeedSource } from "./feeds";
import type { FeedItem } from "./types";

/** One source that could not be loaded; the rest of the feed still renders. */
export interface FeedFailure {
  sourceId: string;
  sourceTitle: string;
  error: string;
}

export interface FeedLoad {
  items: FeedItem[];
  failures: FeedFailure[];
  successfulSources: FeedSource[];
}

/**
 * The URL of one page of a source. Page 1 stays the canonical URL — adding a
 * parameter there would fetch the same items under a second cache key — and the
 * URL API keeps any query string the source already carries intact.
 */
export function pageUrl(source: FeedSource, page: number): string {
  if (page <= 1) return source.url;
  const url = new URL(source.url); // sources are absolute — they are other origins
  url.searchParams.set(source.pageParam, String(page));
  return url.toString();
}

/**
 * Keeps the first occurrence of every id. Pages overlap whenever the source
 * publishes something between two requests: everything shifts one slot down and
 * the last item of page 1 arrives again on page 2.
 */
export function dedupeById(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Parse an RSS 2.0 document into normalized items. */
export function parseFeed(xml: string, source: FeedSource): FeedItem[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");

  // Naive: RSS 2.0 <item> only. Atom <entry> is not handled here.
  const items = Array.from(doc.querySelectorAll("item"));
  return items.map((item) => {
    const link = item.querySelector("link")?.textContent ?? "";
    // Full text: prefer content:encoded, fall back to description.
    // (getElementsByTagName handles the namespaced tag across browsers.)
    const encoded =
      item.getElementsByTagName("content:encoded")[0]?.textContent ?? "";
    const description = item.querySelector("description")?.textContent ?? "";
    // <category> is the publisher's own topic label — the raw material for the
    // interest picker, so it is kept as published and normalized later.
    const categories = Array.from(item.querySelectorAll("category"))
      .map((category) => category.textContent?.trim() ?? "")
      .filter(Boolean);
    return {
      id: link,
      title: item.querySelector("title")?.textContent ?? "(no title)",
      link,
      content: encoded || description,
      categories,
      publishedAt: Date.parse(
        item.querySelector("pubDate")?.textContent ?? ""
      ) || 0,
      sourceId: source.id,
      sourceTitle: source.title,
    };
  });
}

async function fetchPage(source: FeedSource, page: number): Promise<FeedItem[]> {
  const res = await fetch(pageUrl(source, page));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), source);
}

/**
 * The first page of every source, in parallel — this is what the reader sees
 * first, so nothing else is waited for. A source that fails here delivered
 * nothing and is reported.
 */
export async function fetchInitialPages(sources: FeedSource[] = FEEDS): Promise<FeedLoad> {
  const settled = await Promise.allSettled(sources.map((source) => fetchPage(source, 1)));

  const items: FeedItem[] = [];
  const failures: FeedFailure[] = [];
  const successfulSources: FeedSource[] = [];
  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled") {
      items.push(...result.value);
      successfulSources.push(source);
    }
    else
      failures.push({
        sourceId: source.id,
        sourceTitle: source.title,
        error: String(result.reason),
      });
  });

  return { items: dedupeById(items), failures, successfulSources };
}

/**
 * Pages 2..n, streamed to `onBatch` as they arrive: sequential within a source,
 * parallel across sources. A failing page ends that source's pagination
 * silently — the source is already on screen, so there is nothing to warn about.
 */
export async function fetchRemainingPages(
  onBatch: (items: FeedItem[]) => void,
  sources: FeedSource[] = FEEDS
): Promise<void> {
  await Promise.all(
    sources.map(async (source) => {
      for (let page = 2; page <= source.pages; page += 1) {
        let items: FeedItem[];
        try {
          items = await fetchPage(source, page);
        } catch {
          return; // pagination ended (or was blocked) — keep what we have
        }
        if (!items.length) return;
        onBatch(items);
      }
    })
  );
}
