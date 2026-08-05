import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveFeedUrl, proxiedUrl, CORS_PROXY, PROXIES, FEEDS, type FeedSource } from "./feeds";
import { parseFeedXml, parseRss2Json, fetchAllFeeds, fetchAllFeedsDetailed } from "./rss";

// Minimal hand-built DOM stub: enough of querySelectorAll/querySelector/
// getElementsByTagName/getAttribute/textContent for parseFeedXml to work
// against real RSS/Atom XML strings, without pulling in an XML parser lib.
interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: FakeElement[];
}

function el(tag: string, attrs: Record<string, string>, text: string, children: FakeElement[] = []): FakeElement {
  return { tag, attrs, text, children };
}

// Recursively collects descendants matching tag (mirrors real DOM
// querySelectorAll/getElementsByTagName searching the whole subtree, not just
// direct children).
function descendants(root: FakeElement, tag: string): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of root.children) {
    if (child.tag === tag) found.push(child);
    found.push(...descendants(child, tag));
  }
  return found;
}

function withDom(el: FakeElement) {
  const self = el as unknown as {
    tagName: string;
    textContent: string;
    getAttribute: (name: string) => string | null;
    querySelector: (sel: string) => unknown;
    querySelectorAll: (sel: string) => unknown[];
    getElementsByTagName: (name: string) => unknown[];
  };
  self.tagName = el.tag;
  self.textContent = el.text;
  self.getAttribute = (name: string) => (name in el.attrs ? el.attrs[name] : null);
  self.querySelector = (sel: string) => {
    const found = descendants(el, sel)[0];
    return found ? withDom(found) : null;
  };
  self.querySelectorAll = (sel: string) => descendants(el, sel).map(withDom);
  self.getElementsByTagName = (name: string) => descendants(el, name).map(withDom);
  return self;
}

function installFakeDom(root: FakeElement) {
  const rootWithDom = withDom(root);
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
    parseFromString() {
      return rootWithDom;
    }
  };
}

afterEach(() => {
  delete (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
  vi.unstubAllGlobals();
});

describe("resolveFeedUrl", () => {
  it("passes absolute http(s) urls through untouched", () => {
    expect(resolveFeedUrl("https://github.blog/feed/")).toBe("https://github.blog/feed/");
  });

  it("prefixes root-relative paths with BASE_URL without a double slash", () => {
    const resolved = resolveFeedUrl("/mock-feed.xml");
    expect(resolved).not.toContain("//");
    expect(resolved.endsWith("mock-feed.xml")).toBe(true);
  });
});

describe("parseFeedXml", () => {
  const source: FeedSource = { id: "s", title: "Source", url: "https://example.com/feed" };

  it("parses RSS 2.0 items", () => {
    const root = el("rss", {}, "", [
      el("channel", {}, "", [
        el("item", {}, "", [
          el("title", {}, "Hello RSS"),
          el("link", {}, "https://example.com/a"),
          el("description", {}, "A description"),
          el("pubDate", {}, "Mon, 01 Jan 2024 00:00:00 GMT"),
        ]),
      ]),
    ]);
    installFakeDom(root);

    const items = parseFeedXml("<rss></rss>", source);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Hello RSS");
    expect(items[0].link).toBe("https://example.com/a");
    expect(items[0].content).toBe("A description");
    expect(items[0].publishedAt).toBe(Date.parse("Mon, 01 Jan 2024 00:00:00 GMT"));
  });

  it("parses Atom entries (BUG 3 fix)", () => {
    const root = el("feed", {}, "", [
      el("entry", {}, "", [
        el("title", {}, "Hello Atom"),
        el("link", { rel: "alternate", href: "https://example.com/atom-a" }, ""),
        el("summary", {}, "An atom summary"),
        el("updated", {}, "2024-01-01T00:00:00Z"),
      ]),
    ]);
    installFakeDom(root);

    const items = parseFeedXml("<feed></feed>", source);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].title).toBe("Hello Atom");
    expect(items[0].link).toBe("https://example.com/atom-a");
  });

  // Structurally faithful to the real https://www.theverge.com/rss/index.xml
  // (a proxy source): feed-level <link rel="alternate"> AND <link rel="self">
  // before the entries, <author><name> nesting, type attributes, and entry 2
  // covering the <summary>/<published> fallbacks instead of <content>/<updated>.
  const vergeAtom: FakeElement = el("feed", { "xml:lang": "en-US" }, "", [
    el("title", { type: "text" }, "The Verge"),
    el("updated", {}, "2026-08-04T20:26:44+00:00"),
    el("link", { rel: "alternate", type: "text/html", href: "https://www.theverge.com" }, ""),
    el("id", {}, "https://www.theverge.com/rss/index.xml"),
    el("link", { rel: "self", type: "application/atom+xml", href: "https://www.theverge.com/rss/index.xml" }, ""),
    el("entry", {}, "", [
      el("author", {}, "", [el("name", {}, "Jay Peters")]),
      el("title", { type: "html" }, "EA is now a private company"),
      el("link", { rel: "alternate", type: "text/html", href: "https://www.theverge.com/games/974736/ea" }, ""),
      el("id", {}, "https://www.theverge.com/?p=974736"),
      el("updated", {}, "2026-08-04T16:26:44-04:00"),
      el("published", {}, "2026-08-04T16:18:14-04:00"),
      el("summary", { type: "html" }, "EA summary text"),
      el("content", { type: "html" }, "<p>Full EA content body</p>"),
    ]),
    el("entry", {}, "", [
      el("author", {}, "", [el("name", {}, "Emma Roth")]),
      el("title", { type: "html" }, "Second entry, summary only"),
      el("link", { rel: "alternate", type: "text/html", href: "https://www.theverge.com/news/12345/second" }, ""),
      el("id", {}, "https://www.theverge.com/?p=12345"),
      // No <content> and no <updated> → must fall back to summary + published.
      el("published", {}, "2026-08-03T10:00:00-04:00"),
      el("summary", { type: "html" }, "Only a summary here"),
    ]),
    // Multi-link entry: RFC 4287 allows several <link rel=...> per entry, and a
    // non-alternate one may come FIRST. This is what makes atomLinkHref's
    // rel="alternate" preference load-bearing rather than incidental.
    el("entry", {}, "", [
      el("title", { type: "html" }, "Third entry, replies link first"),
      el("link", { rel: "replies", type: "application/atom+xml", href: "https://www.theverge.com/comments/999" }, ""),
      el("link", { rel: "alternate", type: "text/html", href: "https://www.theverge.com/news/999/third" }, ""),
      el("id", {}, "https://www.theverge.com/?p=999"),
      el("updated", {}, "2026-08-02T09:00:00-04:00"),
      el("content", { type: "html" }, "<p>Third body</p>"),
    ]),
  ]);

  it("parses a realistic Atom feed: both entries, links, content, dates", () => {
    installFakeDom(vergeAtom);
    const items = parseFeedXml("<feed></feed>", source);

    expect(items).toHaveLength(3);

    expect(items[0].title).toBe("EA is now a private company");
    expect(items[0].link).toBe("https://www.theverge.com/games/974736/ea");
    // Prefers <content> over <summary>.
    expect(items[0].content).toBe("<p>Full EA content body</p>");
    expect(items[0].publishedAt).toBe(Date.parse("2026-08-04T16:26:44-04:00"));
    expect(items[0].publishedAt).toBeGreaterThan(0);

    expect(items[1].title).toBe("Second entry, summary only");
    expect(items[1].link).toBe("https://www.theverge.com/news/12345/second");
    // Falls back to <summary> and <published>.
    expect(items[1].content).toBe("Only a summary here");
    expect(items[1].publishedAt).toBe(Date.parse("2026-08-03T10:00:00-04:00"));
    expect(items[1].publishedAt).toBeGreaterThan(0);

    expect(items[2].title).toBe("Third entry, replies link first");
    expect(items[2].content).toBe("<p>Third body</p>");
    expect(items[2].publishedAt).toBe(Date.parse("2026-08-02T09:00:00-04:00"));

    for (const item of items) {
      expect(item.content.length).toBeGreaterThan(0);
      expect(item.title).not.toBe("(no title)");
      expect(item.sourceId).toBe(source.id);
    }
  });

  it("picks each entry's own alternate link, not the feed-level or self link", () => {
    installFakeDom(vergeAtom);
    const items = parseFeedXml("<feed></feed>", source);

    // Regression guard: a naive querySelector("link") on the document, or
    // matching rel="self", would yield the feed url for every item.
    for (const item of items) {
      expect(item.link).not.toBe("https://www.theverge.com");
      expect(item.link).not.toBe("https://www.theverge.com/rss/index.xml");
    }
    expect(new Set(items.map((i) => i.link)).size).toBe(3);

    // The decisive case: entry 3 lists rel="replies" BEFORE rel="alternate", so
    // taking the first <link> would pick the comments url. Must pick alternate.
    expect(items[2].link).toBe("https://www.theverge.com/news/999/third");
    expect(items[2].link).not.toContain("/comments/");
  });
});

describe("fetchAllFeedsDetailed", () => {
  beforeEach(() => {
    const root = el("rss", {}, "", [
      el("channel", {}, "", [
        el("item", {}, "", [
          el("title", {}, "OK item"),
          el("link", {}, "https://example.com/ok"),
          el("description", {}, "desc"),
          el("pubDate", {}, "Mon, 01 Jan 2024 00:00:00 GMT"),
        ]),
      ]),
    ]);
    installFakeDom(root);
  });

  it("keeps items from healthy sources and reports one error per failed source (BUG 2 fix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("github.blog")) {
          return { ok: false, status: 500, text: async () => "" } as Response;
        }
        return { ok: true, status: 200, text: async () => "<rss></rss>" } as Response;
      })
    );

    const { items, errors } = await fetchAllFeedsDetailed();

    expect(items.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("GitHub");
  });

  it("fetchAllFeeds still returns just the items", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "<rss></rss>" } as Response)));
    const items = await fetchAllFeeds();
    expect(items.length).toBeGreaterThan(0);
  });
});

describe("proxiedUrl", () => {
  it("prefixes CORS_PROXY and percent-encodes the target url", () => {
    const wrapped = proxiedUrl("https://news.ycombinator.com/rss");
    expect(wrapped.startsWith(CORS_PROXY)).toBe(true);
    expect(wrapped).toBe(CORS_PROXY + "https%3A%2F%2Fnews.ycombinator.com%2Frss");
    // The encoded target must not leak raw separators into the proxy's own query.
    expect(wrapped.slice(CORS_PROXY.length)).not.toContain("/");
    expect(wrapped.slice(CORS_PROXY.length)).not.toContain(":");
  });

  it("encodes a target that has its own query string", () => {
    const wrapped = proxiedUrl("https://example.com/feed?tag=a&n=2");
    expect(wrapped.slice(CORS_PROXY.length)).not.toContain("&");
    expect(wrapped).toContain("%3Ftag%3Da%26n%3D2");
  });
});

describe("parseRss2Json", () => {
  const source: FeedSource = { id: "hn", title: "Hacker News", url: "x", needsProxy: true };

  it("maps items and stamps the source", () => {
    const items = parseRss2Json(
      JSON.stringify({
        status: "ok",
        items: [
          {
            title: "Hello",
            link: "https://example.com/a",
            content: "<p>full</p>",
            description: "short",
            pubDate: "2024-01-02 03:04:05",
          },
        ],
      }),
      source
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "https://example.com/a",
      title: "Hello",
      link: "https://example.com/a",
      // content wins over description — the card wants the full text.
      content: "<p>full</p>",
      sourceId: "hn",
      sourceTitle: "Hacker News",
    });
  });

  it("reads pubDate as UTC, not local time", () => {
    const [item] = parseRss2Json(
      JSON.stringify({ status: "ok", items: [{ pubDate: "2024-01-02 03:04:05" }] }),
      source
    );
    expect(item.publishedAt).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
  });

  it("falls back to description, then guid, and survives missing fields", () => {
    const [item] = parseRss2Json(
      JSON.stringify({ status: "ok", items: [{ description: "short", guid: "urn:1" }] }),
      source
    );
    expect(item).toMatchObject({ id: "urn:1", link: "urn:1", content: "short", title: "(no title)" });
    expect(item.publishedAt).toBe(0);
  });

  it("throws on a non-ok payload so the chain moves to the next proxy", () => {
    expect(() => parseRss2Json(JSON.stringify({ status: "error" }), source)).toThrow(/rss2json/);
  });
});

describe("fetchAllFeedsDetailed proxy sources", () => {
  const proxySources = FEEDS.filter((s) => s.needsProxy);
  const directSources = FEEDS.filter((s) => !s.needsProxy);

  beforeEach(() => {
    const root = el("rss", {}, "", [
      el("channel", {}, "", [
        el("item", {}, "", [
          el("title", {}, "OK item"),
          el("link", {}, "https://example.com/ok"),
          el("description", {}, "desc"),
          el("pubDate", {}, "Mon, 01 Jan 2024 00:00:00 GMT"),
        ]),
      ]),
    ]);
    installFakeDom(root);
  });

  it("has proxy sources configured (HN, Lobsters, The Verge)", () => {
    expect(proxySources.map((s) => s.id).sort()).toEqual(["hn", "lobsters", "theverge"]);
  });

  // Typed param so mock.calls[i][0] is the requested url, not an empty tuple.
  // Proxied sources hit rss2json first, which speaks JSON, not XML — answer each
  // proxy in the shape it actually returns so the chain stops at the primary.
  function okFetch() {
    return vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (url.startsWith(CORS_PROXY) ? rss2jsonBody() : "<rss></rss>"),
    } as Response));
  }

  function rss2jsonBody() {
    return JSON.stringify({
      status: "ok",
      items: [
        {
          title: "OK item",
          link: "https://example.com/ok",
          description: "desc",
          pubDate: "2024-01-01 00:00:00",
        },
      ],
    });
  }

  it("skips proxy sources entirely when useProxy is absent: no proxy fetch, no items, no errors", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { items, errors } = await fetchAllFeedsDetailed();

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(directSources.length);
    for (const url of urls) expect(url).not.toContain(CORS_PROXY);
    // Skipped, not failed.
    expect(errors).toEqual([]);
    for (const source of proxySources) {
      expect(items.some((i) => i.sourceId === source.id)).toBe(false);
    }
  });

  it("does not fetch proxy sources when useProxy is explicitly false", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { errors } = await fetchAllFeedsDetailed({ useProxy: false });

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toHaveLength(directSources.length);
    expect(errors).toEqual([]);
  });

  it("fetches proxy sources through the proxy url when useProxy is true", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { items, errors } = await fetchAllFeedsDetailed({ useProxy: true });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(FEEDS.length);
    for (const source of proxySources) {
      expect(urls).toContain(proxiedUrl(source.url));
      expect(items.some((i) => i.sourceId === source.id)).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  it("never routes the local mock through the proxy, even with useProxy true", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await fetchAllFeedsDetailed({ useProxy: true });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const mockUrls = urls.filter((u) => u.includes("mock-feed.xml"));
    expect(mockUrls).toHaveLength(1);
    expect(mockUrls[0]).not.toContain(CORS_PROXY);
    expect(mockUrls[0]).not.toContain("allorigins");
    // Direct sources stay unproxied too.
    for (const source of directSources) {
      expect(urls.some((u) => u.startsWith(CORS_PROXY) && u.includes(encodeURIComponent(source.url)))).toBe(false);
    }
  });

  const isProxied = (url: string) => PROXIES.some((p) => url.startsWith(p.prefix));

  it("isolates one failing proxied source: other items survive, one labeled error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // Every proxy 5xx-ing for HN only (observed 500/520/522 in practice).
        if (url.includes(encodeURIComponent("news.ycombinator.com"))) {
          return { ok: false, status: 429, text: async () => "" } as Response;
        }
        return {
          ok: true,
          status: 200,
          text: async () => (isProxied(url) ? rss2jsonBody() : "<rss></rss>"),
        } as Response;
      })
    );

    const { items, errors } = await fetchAllFeedsDetailed({ useProxy: true });

    expect(items.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Hacker News");
    // Proxied failures are labeled so a proxy outage is distinguishable.
    expect(errors[0]).toContain("via proxy");
    expect(errors[0]).toContain("HTTP 429");
    // The other proxy sources still contributed.
    expect(items.some((i) => i.sourceId === "lobsters")).toBe(true);
    expect(items.some((i) => i.sourceId === "local")).toBe(true);
  });

  it("falls through to the next proxy when the primary is down", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(PROXIES[0].prefix)) throw new Error("Failed to fetch");
      return { ok: true, status: 200, text: async () => "<rss></rss>" } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { items, errors } = await fetchAllFeedsDetailed({ useProxy: true });

    // A dead primary is survivable: the XML fallback served every proxied source.
    expect(errors).toEqual([]);
    for (const source of proxySources) {
      expect(items.some((i) => i.sourceId === source.id)).toBe(true);
    }
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith(PROXIES[1].prefix))).toBe(true);
  });

  it("reports what each proxy said when the whole chain misses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(encodeURIComponent("lobste.rs"))) throw new Error("Failed to fetch");
        return {
          ok: true,
          status: 200,
          text: async () => (isProxied(url) ? rss2jsonBody() : "<rss></rss>"),
        } as Response;
      })
    );

    const { items, errors } = await fetchAllFeedsDetailed({ useProxy: true });

    expect(items.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Lobsters (via proxy):");
    // Named per proxy, so an outage is diagnosable from the UI alone.
    for (const proxy of PROXIES) expect(errors[0]).toContain(`${proxy.id}: Failed to fetch`);
  });

  it("every proxy being dead still leaves each direct source rendering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (isProxied(url)) throw new Error("proxy down");
        return { ok: true, status: 200, text: async () => "<rss></rss>" } as Response;
      })
    );

    const { items, errors } = await fetchAllFeedsDetailed({ useProxy: true });

    expect(errors).toHaveLength(proxySources.length);
    for (const source of directSources) {
      expect(items.some((i) => i.sourceId === source.id)).toBe(true);
    }
  });
});
