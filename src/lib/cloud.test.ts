import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createCloudSummarizer,
  verifyCloudKey,
  CLAUDE_BROWSER_HEADER,
  GEMINI_MODEL,
  CLAUDE_MODEL,
} from "./cloud";

// Never a real network call and never a real key: `fetch` is stubbed for every
// test, and the fake key below is a literal, not a credential.
const FAKE_KEY = "test-key-not-a-real-credential";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  responder: (call: Captured) => { status?: number; json?: unknown; body?: string }
): Captured[] {
  const calls: Captured[] = [];

  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Captured = {
      url: String(url),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    const { status = 200, json, body } = responder(call);
    const text = body !== undefined ? body : JSON.stringify(json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return JSON.parse(text) as unknown;
      },
    } as Response;
  });

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Captures the rejection as an Error so assertions can read `.message` without
// widening to the resolved `string` type.
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("expected the promise to reject, but it resolved");
}

function geminiOk(text: string) {
  return { json: { candidates: [{ content: { parts: [{ text }] } }] } };
}

function claudeOk(text: string) {
  return { json: { content: [{ type: "text", text }] } };
}

describe("cloud summarizer — Gemini", () => {
  it("posts to the generateContent endpoint for the configured model", async () => {
    const calls = stubFetch(() => geminiOk("a summary"));

    const out = await createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize(
      "some article text"
    );

    expect(out).toBe("a summary");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
    );
  });

  it("sends the key in the x-goog-api-key header, not in the URL", async () => {
    const calls = stubFetch(() => geminiOk("ok"));
    await createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize("text");

    expect(calls[0].headers["x-goog-api-key"]).toBe(FAKE_KEY);
    expect(calls[0].url).not.toContain(FAKE_KEY);
  });

  it("puts the prompt in contents[0].parts[0].text", async () => {
    const calls = stubFetch(() => geminiOk("ok"));
    await createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize(
      "the article body"
    );

    const body = calls[0].body as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.contents[0].parts[0].text).toContain("the article body");
    expect(body.generationConfig.maxOutputTokens).toBe(220);
  });

  it("parses the text out of the nested candidates shape", async () => {
    stubFetch(() => geminiOk("  nested and padded  "));
    const out = await createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize(
      "x"
    );
    expect(out).toBe("nested and padded");
  });
});

describe("cloud summarizer — Claude", () => {
  it("posts to the messages endpoint with the configured model", async () => {
    const calls = stubFetch(() => claudeOk("claude summary"));

    const out = await createCloudSummarizer({ provider: "claude", apiKey: FAKE_KEY }).summarize(
      "some article text"
    );

    expect(out).toBe("claude summary");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0].body as { model: string }).model).toBe(CLAUDE_MODEL);
  });

  it("sends x-api-key, anthropic-version and the browser-access header", async () => {
    const calls = stubFetch(() => claudeOk("ok"));
    await createCloudSummarizer({ provider: "claude", apiKey: FAKE_KEY }).summarize("text");

    expect(calls[0].headers["x-api-key"]).toBe(FAKE_KEY);
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    // Without this header Anthropic rejects every browser-origin call via CORS.
    expect(calls[0].headers[CLAUDE_BROWSER_HEADER]).toBe("true");
  });

  it("parses content[0].text", async () => {
    stubFetch(() => claudeOk("  from a content block  "));
    const out = await createCloudSummarizer({ provider: "claude", apiKey: FAKE_KEY }).summarize(
      "x"
    );
    expect(out).toBe("from a content block");
  });
});

describe("cloud summarizer — errors", () => {
  it("throws an auth-flavoured error on 401 without leaking the key", async () => {
    stubFetch(() => ({ status: 401, json: { error: { message: "API key not valid" } } }));

    const summarizer = createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY });
    await expect(summarizer.summarize("x")).rejects.toThrow(/401/);

    const err = await rejection(summarizer.summarize("x"));
    expect(err.message).toMatch(/[Aa]uthentication failed/);
    expect(err.message).toContain("API key not valid");
    expect(err.message).not.toContain(FAKE_KEY);
  });

  it("also flags a 403 as an auth failure, key-free", async () => {
    stubFetch(() => ({ status: 403, json: { error: { message: "permission denied" } } }));
    const err = await rejection(
      createCloudSummarizer({ provider: "claude", apiKey: FAKE_KEY }).summarize("x")
    );

    expect(err.message).toMatch(/403/);
    expect(err.message).toMatch(/[Aa]uthentication failed/);
    expect(err.message).not.toContain(FAKE_KEY);
  });

  it("reports the status when a non-2xx body is not JSON", async () => {
    stubFetch(() => ({ status: 500, body: "<html>gateway error</html>" }));
    await expect(
      createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize("x")
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws a descriptive error on a malformed Gemini shape", async () => {
    stubFetch(() => ({ json: { candidates: [] } }));
    await expect(
      createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize("x")
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("throws a descriptive error on a malformed Claude shape", async () => {
    stubFetch(() => ({ json: { content: [{ type: "text" }] } }));
    await expect(
      createCloudSummarizer({ provider: "claude", apiKey: FAKE_KEY }).summarize("x")
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("throws instead of returning undefined on an empty 200 body", async () => {
    stubFetch(() => ({ body: "" }));
    await expect(
      createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize("x")
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("never returns undefined for a blank-text response", async () => {
    stubFetch(() => geminiOk("   "));
    await expect(
      createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize("x")
    ).rejects.toThrow(/unexpected response shape/);
  });
});

describe("input capping", () => {
  it("truncates input beyond the cap before sending (Gemini)", async () => {
    const calls = stubFetch(() => geminiOk("ok"));
    const long = "x".repeat(9000);

    await createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize(long);

    const sent = (calls[0].body as { contents: Array<{ parts: Array<{ text: string }> }> })
      .contents[0].parts[0].text;
    expect(sent.length).toBe(4000);
    expect(sent.length).toBeLessThan(long.length);
  });

  it("truncates input beyond the cap before sending (Claude)", async () => {
    const calls = stubFetch(() => claudeOk("ok"));

    await createCloudSummarizer({ provider: "claude", apiKey: FAKE_KEY }).summarize(
      "y".repeat(9000)
    );

    const sent = (calls[0].body as { messages: Array<{ content: string }> }).messages[0].content;
    expect(sent.length).toBe(4000);
  });

  it("does not call the API at all for empty text", async () => {
    const calls = stubFetch(() => geminiOk("ok"));
    const out = await createCloudSummarizer({ provider: "gemini", apiKey: FAKE_KEY }).summarize(
      "   <p></p>  "
    );
    expect(out).toBe("(no summary)");
    expect(calls).toHaveLength(0);
  });
});

describe("verifyCloudKey", () => {
  it("returns ok on a successful round-trip", async () => {
    const calls = stubFetch(() => geminiOk("OK"));
    await expect(verifyCloudKey({ provider: "gemini", apiKey: FAKE_KEY })).resolves.toEqual({
      ok: true,
    });
    expect((calls[0].body as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]
      .parts[0].text).toBe("Reply with OK");
  });

  it("returns ok for Claude too", async () => {
    stubFetch(() => claudeOk("OK"));
    await expect(verifyCloudKey({ provider: "claude", apiKey: FAKE_KEY })).resolves.toEqual({
      ok: true,
    });
  });

  it("returns {ok:false,error} on 401 without throwing", async () => {
    stubFetch(() => ({ status: 401, json: { error: { message: "invalid api key" } } }));

    const result = await verifyCloudKey({ provider: "claude", apiKey: FAKE_KEY });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
    expect(result.error).not.toContain(FAKE_KEY);
  });

  it("does not throw when fetch itself rejects (offline / CORS)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await verifyCloudKey({ provider: "gemini", apiKey: FAKE_KEY });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to fetch");
  });

  it("rejects an empty key without hitting the network", async () => {
    const calls = stubFetch(() => geminiOk("OK"));
    const result = await verifyCloudKey({ provider: "gemini", apiKey: "   " });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
