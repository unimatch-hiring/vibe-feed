// The single read/write boundary for the personalization profile in
// localStorage. Everything stored here is user-chosen and stays in this
// browser: no article content, no credentials, no remote sync.

import {
  EMPTY_PROFILE,
  normalizeTopics,
  SORT_MODES,
  type PersonalizationProfile,
  type SortMode,
} from "./personalize";

const STORAGE_KEY = "vibe-feed:personalization";
// v2 dropped per-article like/dislike feedback, v3 added the sort mode. Older
// profiles are not migrated: they simply reopen the topic picker.
const PROFILE_VERSION = 3;

interface StoredProfile {
  version: number;
  setupCompleted: boolean;
  topics: string[];
  sortMode: SortMode;
}

function storage(): Storage | null {
  // Guarded so pure tests and non-browser rendering never throw (private mode
  // can also make localStorage access itself fail).
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the profile. Missing, malformed or out-of-version data falls back to an
 * unfinished empty profile so a first visit opens setup instead of crashing.
 */
export function loadProfile(): PersonalizationProfile {
  const store = storage();
  if (!store) return EMPTY_PROFILE;

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PROFILE;

    const parsed = JSON.parse(raw) as Partial<StoredProfile> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== PROFILE_VERSION ||
      typeof parsed.setupCompleted !== "boolean" ||
      !Array.isArray(parsed.topics) ||
      !parsed.topics.every((topic) => typeof topic === "string") ||
      !SORT_MODES.includes(parsed.sortMode as SortMode)
    ) {
      return EMPTY_PROFILE;
    }

    return {
      setupCompleted: parsed.setupCompleted,
      topics: normalizeTopics(parsed.topics),
      sortMode: parsed.sortMode as SortMode,
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

/** Persists the profile; a storage failure must not break the UI. */
export function saveProfile(profile: PersonalizationProfile): void {
  const store = storage();
  if (!store) return;

  const stored: StoredProfile = {
    version: PROFILE_VERSION,
    setupCompleted: profile.setupCompleted,
    topics: normalizeTopics(profile.topics),
    sortMode: profile.sortMode,
  };

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage is persistence, not the source of truth — keep rendering.
  }
}
