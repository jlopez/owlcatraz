import type { Storage } from './enrich';

export interface Settings {
  apiKey: string;
  // Per-language deck-name overrides keyed by Duolingo course code (e.g.
  // 'el', 'fr'). Empty/missing entries fall back to the language module's
  // defaultDeckName via resolveDeckName() — see lang/registry.ts.
  deckNames: Record<string, string>;
  skipAudio: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  deckNames: {},
  skipAudio: false,
};

const KEY_API_KEY = 'settings:apiKey';
const KEY_DECKS = 'settings:decks';
// Legacy single-deck key from before per-language storage. Read-only on
// migration — never written from this version forward. See loadSettings.
const KEY_LEGACY_DECK_NAME = 'settings:deckName';
const KEY_SKIP_AUDIO = 'settings:skipAudio';

const STORAGE_KEYS = [KEY_API_KEY, KEY_DECKS, KEY_LEGACY_DECK_NAME, KEY_SKIP_AUDIO] as const;

export interface ApiKeyValidation {
  ok: boolean;
  reason?: string;
  warning?: string;
}

function parseDecksMap(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Skip empty keys and non-string values. An empty key wouldn't match
    // any real language code via resolveDeckName but would survive a load/
    // save cycle as dead data; non-string values come from manual storage
    // corruption (the writer path filters to strings already).
    if (k.length === 0) continue;
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

export async function loadSettings(storage: Storage): Promise<Settings> {
  const stored = await storage.get([...STORAGE_KEYS]);
  const apiKeyRaw = stored[KEY_API_KEY];
  const skipAudioRaw = stored[KEY_SKIP_AUDIO];

  // Presence of KEY_DECKS (even as an empty map) means the user has saved
  // under the new shape at least once — treat that as authoritative and
  // skip the legacy fallback. Distinguishing "absent" from "present but
  // empty" preserves the case where a user clears every per-language
  // override (it must NOT silently restore a long-deleted legacy value on
  // the next load).
  let deckNames: Record<string, string> = {};
  if (KEY_DECKS in stored) {
    const parsed = parseDecksMap(stored[KEY_DECKS]);
    if (parsed !== null) deckNames = parsed;
    // parsed === null means the stored value was a primitive or array
    // (manual corruption). Fall through to empty map — defaults will fill
    // in via resolveDeckName at consumption time.
  } else {
    const legacy = stored[KEY_LEGACY_DECK_NAME];
    if (typeof legacy === 'string' && legacy.length > 0) {
      deckNames = { el: legacy };
    }
  }

  return {
    apiKey: typeof apiKeyRaw === 'string' ? apiKeyRaw : DEFAULT_SETTINGS.apiKey,
    deckNames,
    skipAudio: typeof skipAudioRaw === 'boolean' ? skipAudioRaw : DEFAULT_SETTINGS.skipAudio,
  };
}

export async function saveSettings(storage: Storage, partial: Partial<Settings>): Promise<void> {
  const writes: Record<string, unknown> = {};
  if (partial.apiKey !== undefined) writes[KEY_API_KEY] = partial.apiKey;
  if (partial.deckNames !== undefined) {
    // Filter out empty values on the way in so an empty string from the
    // settings UI cleanly reverts that language to its module default on
    // next load (rather than persisting an empty override that would
    // collide with the resolveDeckName fallback logic).
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(partial.deckNames)) {
      if (typeof v === 'string' && v.length > 0) filtered[k] = v;
    }
    writes[KEY_DECKS] = filtered;
  }
  if (partial.skipAudio !== undefined) writes[KEY_SKIP_AUDIO] = partial.skipAudio;
  if (Object.keys(writes).length === 0) return;
  await storage.set(writes);
}

export function validateApiKey(key: string): ApiKeyValidation {
  if (key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  if (!key.startsWith('sk-ant-')) {
    return {
      ok: true,
      warning: 'Key does not start with "sk-ant-" — double-check it was pasted correctly.',
    };
  }
  return { ok: true };
}

export const __test = {
  KEY_API_KEY,
  KEY_DECKS,
  KEY_LEGACY_DECK_NAME,
  KEY_SKIP_AUDIO,
  STORAGE_KEYS,
};
