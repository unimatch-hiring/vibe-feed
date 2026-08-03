import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadProfile, saveProfile } from "./personalization-profile";
import { EMPTY_PROFILE } from "./personalize";

// Minimal localStorage stand-in: the test environment is node, and the profile
// boundary only needs getItem/setItem.
function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

const globalWithWindow = globalThis as { window?: { localStorage: Storage } };

beforeEach(() => {
  globalWithWindow.window = { localStorage: fakeStorage() };
});

afterEach(() => {
  delete globalWithWindow.window;
});

describe("personalization profile storage", () => {
  it("round-trips a completed profile and falls back to an unfinished one", () => {
    expect(loadProfile()).toEqual(EMPTY_PROFILE);

    const saved = { setupCompleted: true, topics: ["rust", "rss"], sortMode: "latest" as const };
    saveProfile(saved);
    expect(loadProfile()).toEqual(saved);

    globalWithWindow.window!.localStorage.setItem("vibe-feed:personalization", "{not json");
    expect(loadProfile()).toEqual(EMPTY_PROFILE);

    globalWithWindow.window!.localStorage.setItem(
      "vibe-feed:personalization",
      JSON.stringify({ version: 3, setupCompleted: true, topics: "rust", sortMode: "latest" })
    );
    expect(loadProfile()).toEqual(EMPTY_PROFILE);

    // An older profile (v1 feedback, v2 without a sort mode) is not migrated:
    // setup reopens instead.
    globalWithWindow.window!.localStorage.setItem(
      "vibe-feed:personalization",
      JSON.stringify({ version: 1, setupCompleted: true, topics: ["rust"], feedback: {} })
    );
    expect(loadProfile()).toEqual(EMPTY_PROFILE);

    globalWithWindow.window!.localStorage.setItem(
      "vibe-feed:personalization",
      JSON.stringify({ version: 3, setupCompleted: true, topics: ["rust"], sortMode: "best" })
    );
    expect(loadProfile()).toEqual(EMPTY_PROFILE);

    delete globalWithWindow.window;
    expect(loadProfile()).toEqual(EMPTY_PROFILE);
    expect(() => saveProfile(saved)).not.toThrow();
  });
});
