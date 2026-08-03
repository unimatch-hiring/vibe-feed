// Public RSS/Atom sources for the feed.
//
// NOTE (this is part of the task, not a bug): the sources are intentionally
// heterogeneous — feeds come in different formats (RSS 2.0 and Atom), and the
// parser in rss.ts is naive and only understands RSS 2.0 <item>.
//
// The default sources all load with a plain browser fetch — they send CORS
// headers. Add more if you like.

export interface FeedSource {
  id: string;
  title: string;
  url: string;
  // How the source paginates. RSS shows only the newest page, so the archive is
  // reachable only through the source's own page parameter — and they disagree
  // on its name, which makes it a property of the source, not of the loader.
  pageParam: string;
  pages: number; // pages to pull, including the canonical first one
}

// Pages beyond the first are what makes the topic catalogue representative: one
// page per source is ~22 articles, where most tags occur exactly once.
const PAGES_PER_SOURCE = 5;

// The feed shows live sources only. `public/mock-feed.xml` stays in the repo as
// an offline fixture for local experiments and tests, but it is deliberately NOT
// a source: invented articles must never appear among real ones.
export const FEEDS: FeedSource[] = [
  {
    id: "github",
    title: "The GitHub Blog",
    url: "https://github.blog/feed/",
    pageParam: "paged",
    pages: PAGES_PER_SOURCE,
  },
  {
    id: "devto",
    title: "DEV Community",
    url: "https://dev.to/feed",
    pageParam: "page",
    pages: PAGES_PER_SOURCE,
  },
  // More sources you can add — but these do NOT serve CORS headers, so a direct
  // browser fetch fails and you'd need a CORS proxy (your call):
  //   https://news.ycombinator.com/rss        (Hacker News)
  //   https://lobste.rs/rss                    (Lobsters)
  //   https://www.theverge.com/rss/index.xml   (Atom, not RSS 2.0)
];
