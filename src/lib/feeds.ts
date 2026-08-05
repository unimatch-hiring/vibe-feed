// Public RSS/Atom sources for the feed.
//
// NOTE (this is part of the task, not a bug): the sources are intentionally
// heterogeneous — feeds come in different formats (RSS 2.0 and Atom); rss.ts
// handles both.
//
// Sources split into two groups:
//   - direct: load with a plain browser fetch (local mock is served by the dev
//     server; the network ones send CORS headers).
//   - needsProxy: no CORS headers upstream, so a direct browser fetch fails.
//     These are opt-in and routed through a third-party CORS proxy.

export interface FeedSource {
  id: string;
  title: string;
  url: string;
  // No CORS headers upstream → only fetchable via PROXIES. Sources with this
  // set are skipped entirely unless the user opts in (see fetchAllFeedsDetailed).
  needsProxy?: boolean;
}

// Third-party CORS proxies, tried in order (see fetchViaProxy in rss.ts).
//
// Tradeoff, deliberately opt-in: these route requests through services we don't
// control. Free CORS proxies also rot constantly — probing on 2026-08-04, every
// raw-XML one was unusable at once: allorigins timed out, codetabs 521,
// cors.lol and cors.eu.org 429, cors.isomorphic-git 403, thingproxy's domain
// stopped resolving, and corsproxy.io/corsfix had moved behind a paywall. Hence
// a chain rather than a single host: one dead proxy falls through to the next,
// and only an all-miss becomes a per-source error.
export type ProxyKind = "xml" | "rss2json";

export interface ProxyStrategy {
  id: string;
  // The percent-encoded target url gets appended to this.
  prefix: string;
  // Response shape: raw upstream XML, or rss2json's own normalized JSON.
  kind: ProxyKind;
}

export const PROXIES: ProxyStrategy[] = [
  // Primary: the only probe that answered on all three feeds with a usable
  // Access-Control-Allow-Origin. Purpose-built for feeds, so it also normalizes
  // Atom into the same JSON shape as RSS. Free tier is rate-limited per IP.
  {
    id: "rss2json",
    prefix: "https://api.rss2json.com/v1/api.json?rss_url=",
    kind: "rss2json",
  },
  // Raw-XML fallbacks. Both were down when this was written; they cost nothing
  // while the primary answers, and have come back from outages before.
  { id: "allorigins", prefix: "https://api.allorigins.win/raw?url=", kind: "xml" },
  { id: "codetabs", prefix: "https://api.codetabs.com/v1/proxy?quest=", kind: "xml" },
];

// Kept as the "default proxy" shorthand: the head of the chain.
export const CORS_PROXY = PROXIES[0].prefix;

// Wraps a target url for a CORS proxy. The target must be percent-encoded, or
// its own query string would be swallowed into the proxy's own `url` param.
export function proxiedUrl(url: string, proxy: ProxyStrategy = PROXIES[0]): string {
  return proxy.prefix + encodeURIComponent(url);
}

export const FEEDS: FeedSource[] = [
  {
    // Local mock, served by the dev server. Works offline, no network needed —
    // so the feed is alive out of the box on any machine. Root-relative, so it
    // needs resolveFeedUrl() to account for vite.config.ts's `base`.
    id: "local",
    title: "Local mock feed",
    url: "/mock-feed.xml",
  },
  {
    id: "github",
    title: "The GitHub Blog",
    url: "https://github.blog/feed/",
  },
  {
    id: "devto",
    title: "DEV Community",
    url: "https://dev.to/feed",
  },
  // These serve no CORS headers → proxy-only, opt-in.
  {
    id: "hn",
    title: "Hacker News",
    url: "https://news.ycombinator.com/rss",
    needsProxy: true,
  },
  {
    id: "lobsters",
    title: "Lobsters",
    url: "https://lobste.rs/rss",
    needsProxy: true,
  },
  {
    id: "theverge",
    title: "The Verge",
    // Atom, not RSS 2.0 — exercises the <entry> branch in rss.ts.
    url: "https://www.theverge.com/rss/index.xml",
    needsProxy: true,
  },
];

// Resolves a source url for fetching. Absolute http(s) urls (network sources)
// pass through untouched. Root-relative paths (the local mock) get the
// deployed base prefixed — vite.config.ts serves this app under `/vibe-feed/`,
// so `/mock-feed.xml` alone 404s once deployed there.
export function resolveFeedUrl(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  const base = import.meta.env.BASE_URL ?? "/";
  return base.replace(/\/$/, "") + "/" + url.replace(/^\//, "");
}
