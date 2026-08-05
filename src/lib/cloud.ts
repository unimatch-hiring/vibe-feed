// Cloud LLM engines behind the same narrow `Summarizer` interface as the mock and
// the on-device (WebLLM) path — so a cloud engine powers both card summaries and
// the agentic rerank without either caller knowing which provider is behind it.
//
// Deliberately no provider SDKs: both are thin wrappers over one HTTPS POST, and
// this app ships to a static host with no build-time dependency budget to spend.
// Plain `fetch` against the documented REST endpoints is equivalent in a browser.
//
// The API key lives in the browser and travels straight from the browser to the
// provider. Two consequences the code has to honour:
//   - the key must never end up inside an error message (errors reach the UI and
//     the console), so we only ever surface the provider's own message + status;
//   - Anthropic blocks browser-origin calls unless the caller explicitly opts in
//     with `anthropic-dangerous-direct-browser-access`, see CLAUDE_BROWSER_HEADER.

import type { Summarizer } from "./summarizer";

export type CloudProvider = "gemini" | "claude";

export interface CloudConfig {
  provider: CloudProvider;
  apiKey: string;
}

export const GEMINI_MODEL = "gemini-2.0-flash";
export const CLAUDE_MODEL = "claude-sonnet-4-5";

// Cloud context windows are large, but an RSS item's full text is still worth
// capping: it bounds cost per card and keeps latency predictable.
const MAX_INPUT_CHARS = 4000;

const MAX_OUTPUT_TOKENS = 220;
const TEMPERATURE = 0.3;

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const CLAUDE_ENDPOINT = "https://api.anthropic.com/v1/messages";

// Without this header Anthropic rejects any request carrying an `Origin`, i.e.
// every browser call, as a CORS failure.
export const CLAUDE_BROWSER_HEADER = "anthropic-dangerous-direct-browser-access";
const ANTHROPIC_VERSION = "2023-06-01";

export function truncateInput(text: string): string {
  return text.slice(0, MAX_INPUT_CHARS);
}

function providerLabel(provider: CloudProvider): string {
  return provider === "gemini" ? "Gemini" : "Claude";
}

// --- Response narrowing. No `any`: the shapes below are untrusted input. ---

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstElement(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// The provider's own error message, if the body is parseable and says something.
// Both providers use `{ error: { message } }`; Gemini sometimes wraps it in an
// array. Anything else → null, and the caller falls back to the bare status.
function extractErrorMessage(body: unknown): string | null {
  const rec = asRecord(body) ?? asRecord(firstElement(body));
  if (!rec) return null;

  const err = asRecord(rec.error);
  if (err) {
    const msg = asNonEmptyString(err.message);
    if (msg) return msg;
    const status = asNonEmptyString(err.status);
    if (status) return status;
  }
  return asNonEmptyString(rec.message);
}

// One error path for both providers, so a 401 reads the same either way and no
// branch can accidentally interpolate the key.
async function throwHttpError(provider: CloudProvider, res: Response): Promise<never> {
  let detail: string | null = null;
  try {
    detail = extractErrorMessage(await res.json());
  } catch {
    // Non-JSON or empty body — the status alone has to carry the meaning.
  }

  const auth =
    res.status === 401 || res.status === 403
      ? " Authentication failed — the API key looks invalid, expired, or not permitted for this model."
      : "";

  throw new Error(
    `${providerLabel(provider)} request failed with HTTP ${res.status}${
      detail ? `: ${detail}` : ""
    }.${auth}`
  );
}

function shapeError(provider: CloudProvider): Error {
  return new Error(
    `${providerLabel(provider)} returned an unexpected response shape — no text content found.`
  );
}

// --- Gemini ---

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Header rather than the `?key=` query param: keys in URLs leak into
      // browser history, referrers and server logs.
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE },
    }),
  });

  if (!res.ok) await throwHttpError("gemini", res);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw shapeError("gemini");
  }

  const root = asRecord(data);
  if (!root) throw shapeError("gemini");

  const candidate = asRecord(firstElement(root.candidates));
  if (!candidate) throw shapeError("gemini");

  const content = asRecord(candidate.content);
  if (!content) throw shapeError("gemini");

  const part = asRecord(firstElement(content.parts));
  const text = part ? asNonEmptyString(part.text) : null;
  if (!text) throw shapeError("gemini");

  return text.trim();
}

// --- Claude ---

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(CLAUDE_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      [CLAUDE_BROWSER_HEADER]: "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) await throwHttpError("claude", res);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw shapeError("claude");
  }

  const root = asRecord(data);
  if (!root) throw shapeError("claude");

  const block = asRecord(firstElement(root.content));
  const text = block ? asNonEmptyString(block.text) : null;
  if (!text) throw shapeError("claude");

  return text.trim();
}

async function call(config: CloudConfig, prompt: string): Promise<string> {
  return config.provider === "gemini"
    ? callGemini(config.apiKey, prompt)
    : callClaude(config.apiKey, prompt);
}

// --- Public surface ---

export function createCloudSummarizer(config: CloudConfig): Summarizer {
  return {
    async summarize(text: string): Promise<string> {
      const clean = truncateInput(text.replace(/<[^>]*>/g, "").trim());
      if (!clean) return "(no summary)";
      // The prompt is passed through as-is: `agenticRerank` sends a full
      // instruction block through this same seam, and wrapping it would corrupt
      // the tool-call format it expects back.
      return (await call(config, clean)) || "(no summary)";
    },
  };
}

// Cheapest possible round-trip, used by the UI to validate a pasted key. Never
// throws — a bad key is an expected outcome here, not an exception.
export async function verifyCloudKey(
  config: CloudConfig
): Promise<{ ok: boolean; error?: string }> {
  if (!config.apiKey.trim()) {
    return { ok: false, error: "No API key entered." };
  }
  try {
    await call(config, "Reply with OK");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
