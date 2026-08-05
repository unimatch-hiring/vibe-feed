// Normalized article model in the feed.
export interface FeedItem {
  id: string;          // stable id (e.g. the link)
  title: string;
  link: string;
  content: string;     // full article text from the feed (HTML; content:encoded
                       // when present, else description). May still be partial —
                       // RSS gives what the publisher chose to include.
  publishedAt: number; // unix ms; 0 if the date couldn't be parsed
  sourceId: string;    // source id from feeds.ts
  sourceTitle: string;
}

// A FeedItem with its ranking breakdown. The components are kept alongside the
// final score so the UI can explain the ordering instead of asserting it.
export interface ScoredItem {
  item: FeedItem;
  score: number;
  semantic: number;
  recency: number;
  feedback: number;
  duplicates: FeedItem[];   // collapsed near-duplicates; [] if none
  why: string;              // short human-readable reason
  // Cold start uses a different formula (recency at full weight, see rankFeed),
  // so the UI must know which one produced `score` before explaining it.
  cold: boolean;
}
