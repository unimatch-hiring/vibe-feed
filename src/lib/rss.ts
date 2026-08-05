// Fetch and parse RSS/Atom directly in the browser.
//
// Handles both formats:
//   - RSS 2.0 (<item>)
//   - Atom (<entry>)
// and isolates per-source failures (fetchAllFeedsDetailed uses Promise.allSettled,
// not Promise.all) so one flaky network source doesn't empty the whole feed.
//
// Default sources (see feeds.ts) all load with a plain fetch — local mock is
// served by the dev server, the network ones send CORS headers. Sources marked
// needsProxy (HN, Lobsters, The Verge) have no CORS headers and are reachable
// only through a third-party CORS proxy, so they are opt-in: skipped entirely
// unless the caller passes useProxy. Those walk the PROXIES chain, which mixes
// raw-XML proxies with rss2json's normalized JSON — hence two parsers below.

import { FEEDS, PROXIES, proxiedUrl, resolveFeedUrl, type FeedSource } from "./feeds";
import type { FeedItem } from "./types";

function parseRssItem(item: Element, source: FeedSource): FeedItem {
  const link = item.querySelector("link")?.textContent ?? "";
  // Full text: prefer content:encoded, fall back to description.
  // (getElementsByTagName handles the namespaced tag across browsers.)
  const encoded =
    item.getElementsByTagName("content:encoded")[0]?.textContent ?? "";
  const description = item.querySelector("description")?.textContent ?? "";
  return {
    id: link,
    title: item.querySelector("title")?.textContent ?? "(no title)",
    link,
    content: encoded || description,
    publishedAt: Date.parse(
      item.querySelector("pubDate")?.textContent ?? ""
    ) || 0,
    sourceId: source.id,
    sourceTitle: source.title,
  };
}

function atomLinkHref(entry: Element): string {
  const links = Array.from(entry.querySelectorAll("link"));
  const alternate = links.find((l) => l.getAttribute("rel") === "alternate");
  const withHref = alternate ?? links.find((l) => l.getAttribute("href"));
  return withHref?.getAttribute("href") ?? "";
}

function parseAtomEntry(entry: Element, source: FeedSource): FeedItem {
  const link = atomLinkHref(entry);
  const content =
    entry.querySelector("content")?.textContent ??
    entry.querySelector("summary")?.textContent ??
    "";
  const date =
    entry.querySelector("updated")?.textContent ??
    entry.querySelector("published")?.textContent ??
    "";
  return {
    id: link,
    title: entry.querySelector("title")?.textContent ?? "(no title)",
    link,
    content,
    publishedAt: Date.parse(date) || 0,
    sourceId: source.id,
    sourceTitle: source.title,
  };
}

// Parses either RSS 2.0 or Atom XML into normalized items. Returns [] if
// DOMParser isn't available (e.g. running under Node/vitest, not a browser).
export function parseFeedXml(text: string, source: FeedSource): FeedItem[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(text, "text/xml");

  const rssItems = Array.from(doc.querySelectorAll("item"));
  if (rssItems.length > 0) return rssItems.map((item) => parseRssItem(item, source));

  const atomEntries = Array.from(doc.querySelectorAll("entry"));
  return atomEntries.map((entry) => parseAtomEntry(entry, source));
}

interface Rss2JsonItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  content?: string;
  description?: string;
}

// rss2json returns its own normalized JSON instead of the upstream body, so it
// needs a parser of its own. Unlike parseFeedXml this works without a DOM.
export function parseRss2Json(text: string, source: FeedSource): FeedItem[] {
  const payload = JSON.parse(text) as { status?: string; items?: Rss2JsonItem[] };
  if (payload.status !== "ok") throw new Error(`rss2json status ${payload.status ?? "missing"}`);
  return (payload.items ?? []).map((item) => {
    const link = item.link || item.guid || "";
    return {
      id: link,
      title: item.title ?? "(no title)",
      link,
      content: item.content || item.description || "",
      publishedAt: parseRss2JsonDate(item.pubDate),
      sourceId: source.id,
      sourceTitle: source.title,
    };
  });
}

// Dates arrive as "2026-08-04 15:16:22" — UTC, but not ISO. Date.parse would
// read that as local time where it works at all, so pin the zone explicitly.
function parseRss2JsonDate(value?: string): number {
  if (!value) return 0;
  return Date.parse(value.replace(" ", "T") + "Z") || Date.parse(value) || 0;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Walks the proxy chain: free CORS proxies go down often and independently, so a
// dead primary must not take the source down with it. An empty parse counts as a
// miss too — a proxy that answers 200 with an error page is no more useful than
// one that refuses. Only an all-miss throws, reporting what each proxy said.
async function fetchViaProxy(source: FeedSource, target: string): Promise<FeedItem[]> {
  const failures: string[] = [];
  for (const proxy of PROXIES) {
    try {
      const text = await fetchText(proxiedUrl(target, proxy));
      const items =
        proxy.kind === "rss2json" ? parseRss2Json(text, source) : parseFeedXml(text, source);
      if (items.length > 0) return items;
      failures.push(`${proxy.id}: no items`);
    } catch (err) {
      failures.push(`${proxy.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(failures.join("; "));
}

async function fetchFeed(source: FeedSource): Promise<FeedItem[]> {
  const resolved = resolveFeedUrl(source.url);
  // The local mock is same-origin and must never be routed through a third party.
  if (source.needsProxy && /^https?:\/\//.test(resolved)) {
    return fetchViaProxy(source, resolved);
  }
  return parseFeedXml(await fetchText(resolved), source);
}

export interface FetchAllOptions {
  // Opt in to sources that need the third-party CORS proxy. Off by default:
  // those requests would otherwise silently pass through a service we don't
  // control.
  useProxy?: boolean;
}

// Loads all feeds, isolating failures per source: one down source (flaky
// network, CORS, 500, or a dead proxy) no longer empties the whole feed.
//
// Proxy sources are skipped — not fetched, not reported as errors — unless
// useProxy is set. Errors from proxied sources are labeled "(via proxy)" so a
// proxy outage is distinguishable from the upstream source being down.
export async function fetchAllFeedsDetailed(
  opts?: FetchAllOptions
): Promise<{ items: FeedItem[]; errors: string[] }> {
  const useProxy = opts?.useProxy ?? false;
  const sources = FEEDS.filter((source) => useProxy || !source.needsProxy);

  const results = await Promise.allSettled(sources.map(fetchFeed));

  const items: FeedItem[] = [];
  const errors: string[] = [];
  results.forEach((result, i) => {
    const source = sources[i];
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      const label = source.needsProxy ? `${source.title} (via proxy)` : source.title;
      errors.push(`${label}: ${reason}`);
    }
  });

  return { items, errors };
}

// Back-compat: same as fetchAllFeedsDetailed, but drops per-source errors.
export async function fetchAllFeeds(opts?: FetchAllOptions): Promise<FeedItem[]> {
  const { items } = await fetchAllFeedsDetailed(opts);
  return items;
}
