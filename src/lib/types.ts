// Normalized article model in the feed.
export interface FeedItem {
  id: string;          // stable id (e.g. the link)
  title: string;
  link: string;
  content: string;     // full article text from the feed (HTML; content:encoded
                       // when present, else description). May still be partial —
                       // RSS gives what the publisher chose to include.
  categories: string[]; // <category> tags as published (original casing)
  publishedAt: number; // unix ms; 0 if the date couldn't be parsed
  sourceId: string;    // source id from feeds.ts
  sourceTitle: string;
}
