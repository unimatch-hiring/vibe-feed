import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadInterests,
  saveInterests,
  loadCloudConfig,
  saveCloudConfig,
} from "./storage";
import { EMPTY_INTERESTS } from "./personalize";

// Vitest runs in Node — there is no localStorage. Install a tiny in-memory fake.
const KEY = "vibe-feed.interests";
const CLOUD_KEY = "vibe-feed.cloud";

// Not a credential — a literal used only against the in-memory fake storage.
const FAKE_KEY = "test-key-not-a-real-credential";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

let store: Storage;

beforeEach(() => {
  store = fakeStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("storage", () => {
  it("round-trips interests", () => {
    const i = { topics: ["webgpu", "rss"], liked: ["a"], disliked: ["b"] };
    saveInterests(i);
    expect(loadInterests()).toEqual(i);
  });

  it("returns EMPTY_INTERESTS when the key is absent", () => {
    expect(loadInterests()).toEqual(EMPTY_INTERESTS);
  });

  it("returns EMPTY_INTERESTS on corrupt JSON", () => {
    store.setItem(KEY, "{not json at all");
    expect(loadInterests()).toEqual(EMPTY_INTERESTS);
  });

  it("returns EMPTY_INTERESTS when the stored value is not an object", () => {
    store.setItem(KEY, JSON.stringify(["webgpu"]));
    expect(loadInterests()).toEqual(EMPTY_INTERESTS);
    store.setItem(KEY, JSON.stringify(null));
    expect(loadInterests()).toEqual(EMPTY_INTERESTS);
  });

  it("falls back to empty arrays for missing fields", () => {
    store.setItem(KEY, JSON.stringify({ topics: ["webgpu"] }));
    expect(loadInterests()).toEqual({ topics: ["webgpu"], liked: [], disliked: [] });
  });

  it("falls back to empty arrays for wrong-typed fields", () => {
    store.setItem(KEY, JSON.stringify({ topics: "webgpu", liked: 7, disliked: {} }));
    expect(loadInterests()).toEqual(EMPTY_INTERESTS);
  });

  it("drops non-string entries inside the arrays", () => {
    store.setItem(KEY, JSON.stringify({ topics: ["ok", 3, null], liked: ["a", {}], disliked: [] }));
    expect(loadInterests()).toEqual({ topics: ["ok"], liked: ["a"], disliked: [] });
  });

  it("does not throw when localStorage is unavailable", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(loadInterests()).toEqual(EMPTY_INTERESTS);
    expect(() => saveInterests({ topics: ["x"], liked: [], disliked: [] })).not.toThrow();
  });

  it("never hands out the shared EMPTY_INTERESTS arrays for callers to mutate", () => {
    const loaded = loadInterests();
    loaded.topics.push("mutated");
    expect(EMPTY_INTERESTS.topics).toEqual([]);
  });
});

describe("storage — cloud config", () => {
  it("round-trips a cloud config", () => {
    const c = { provider: "gemini", apiKey: FAKE_KEY } as const;
    saveCloudConfig(c);
    expect(loadCloudConfig()).toEqual(c);
  });

  it("round-trips the claude provider too", () => {
    saveCloudConfig({ provider: "claude", apiKey: FAKE_KEY });
    expect(loadCloudConfig()).toEqual({ provider: "claude", apiKey: FAKE_KEY });
  });

  it("uses a storage key distinct from the interests one", () => {
    saveCloudConfig({ provider: "gemini", apiKey: FAKE_KEY });
    expect(store.getItem(CLOUD_KEY)).not.toBeNull();
    expect(store.getItem(KEY)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadCloudConfig()).toBeNull();
  });

  it("clears the stored config on save(null)", () => {
    saveCloudConfig({ provider: "gemini", apiKey: FAKE_KEY });
    saveCloudConfig(null);
    expect(loadCloudConfig()).toBeNull();
    expect(store.getItem(CLOUD_KEY)).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    store.setItem(CLOUD_KEY, "{not json at all");
    expect(loadCloudConfig()).toBeNull();
  });

  it("returns null when the stored value is not an object", () => {
    store.setItem(CLOUD_KEY, JSON.stringify(["gemini", FAKE_KEY]));
    expect(loadCloudConfig()).toBeNull();
    store.setItem(CLOUD_KEY, JSON.stringify(null));
    expect(loadCloudConfig()).toBeNull();
  });

  it("returns null for an unknown provider value", () => {
    store.setItem(CLOUD_KEY, JSON.stringify({ provider: "openai", apiKey: FAKE_KEY }));
    expect(loadCloudConfig()).toBeNull();
    store.setItem(CLOUD_KEY, JSON.stringify({ provider: 7, apiKey: FAKE_KEY }));
    expect(loadCloudConfig()).toBeNull();
  });

  it("returns null for a missing / empty / wrong-typed key", () => {
    store.setItem(CLOUD_KEY, JSON.stringify({ provider: "gemini" }));
    expect(loadCloudConfig()).toBeNull();
    store.setItem(CLOUD_KEY, JSON.stringify({ provider: "gemini", apiKey: "" }));
    expect(loadCloudConfig()).toBeNull();
    store.setItem(CLOUD_KEY, JSON.stringify({ provider: "gemini", apiKey: 123 }));
    expect(loadCloudConfig()).toBeNull();
  });

  it("does not propagate a throwing setItem (quota / private mode)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        ...store,
        getItem: (k: string) => store.getItem(k),
        setItem: () => {
          throw new DOMException("QuotaExceededError");
        },
        removeItem: () => {
          throw new DOMException("QuotaExceededError");
        },
      },
      configurable: true,
      writable: true,
    });

    expect(() => saveCloudConfig({ provider: "gemini", apiKey: FAKE_KEY })).not.toThrow();
    expect(() => saveCloudConfig(null)).not.toThrow();
  });

  it("does not throw when localStorage is unavailable", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(loadCloudConfig()).toBeNull();
    expect(() => saveCloudConfig({ provider: "claude", apiKey: FAKE_KEY })).not.toThrow();
    expect(() => saveCloudConfig(null)).not.toThrow();
  });
});
