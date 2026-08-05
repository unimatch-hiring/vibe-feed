// Persistence for the interest model. localStorage is enough: the payload is a
// handful of strings, and it must survive a reload without a backend.
//
// Everything here is defensive on purpose. The stored value is user-editable and
// may be from an older shape of UserInterests, so a bad read degrades to cold
// start instead of throwing and taking the feed down with it.

import { EMPTY_INTERESTS, type UserInterests } from "./personalize";
// Type-only: no runtime import, so there is no storage↔cloud module cycle.
import type { CloudConfig, CloudProvider } from "./cloud";

const KEY = "vibe-feed.interests";
const CLOUD_KEY = "vibe-feed.cloud";

// Guarded because vitest runs in Node and Safari private mode throws on access.
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function emptyInterests(): UserInterests {
  // Fresh arrays — callers (React state, the UI's like buttons) mutate what they
  // get back, and EMPTY_INTERESTS is a shared module-level constant.
  return { topics: [], liked: [], disliked: [] };
}

export function loadInterests(): UserInterests {
  const store = storage();
  if (!store) return emptyInterests();

  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return emptyInterests();
  }
  if (raw === null) return emptyInterests();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyInterests();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyInterests();
  }

  const rec = parsed as Record<string, unknown>;
  return {
    topics: stringArray(rec.topics),
    liked: stringArray(rec.liked),
    disliked: stringArray(rec.disliked),
  };
}

export function saveInterests(i: UserInterests): void {
  const store = storage();
  if (!store) return;

  try {
    store.setItem(
      KEY,
      JSON.stringify({
        topics: stringArray(i?.topics),
        liked: stringArray(i?.liked),
        disliked: stringArray(i?.disliked),
      })
    );
  } catch {
    // Quota exceeded / private mode. Losing persistence is not worth an exception.
  }
}

// --- Cloud engine config (provider + API key). ---
//
// The key is stored in plain localStorage: there is no backend to hold it, and
// anything "encrypted" client-side would only be obfuscation. The UI states this
// plainly next to the input — see the warning in App.tsx.

function isProvider(value: unknown): value is CloudProvider {
  return value === "gemini" || value === "claude";
}

export function loadCloudConfig(): CloudConfig | null {
  const store = storage();
  if (!store) return null;

  let raw: string | null;
  try {
    raw = store.getItem(CLOUD_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const rec = parsed as Record<string, unknown>;
  if (!isProvider(rec.provider)) return null;
  if (typeof rec.apiKey !== "string" || rec.apiKey.length === 0) return null;

  return { provider: rec.provider, apiKey: rec.apiKey };
}

export function saveCloudConfig(c: CloudConfig | null): void {
  const store = storage();
  if (!store) return;

  try {
    if (c === null || !isProvider(c.provider) || typeof c.apiKey !== "string" || !c.apiKey) {
      store.removeItem(CLOUD_KEY);
      return;
    }
    store.setItem(CLOUD_KEY, JSON.stringify({ provider: c.provider, apiKey: c.apiKey }));
  } catch {
    // Quota exceeded / private mode. Same rule as saveInterests: losing
    // persistence must not take the app down.
  }
}

// Re-exported so callers don't need both modules just to spell "cold start".
export { EMPTY_INTERESTS };
