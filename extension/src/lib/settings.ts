import type { Storage } from './enrich';

export interface Settings {
  apiKey: string;
  deckName: string;
  skipAudio: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  deckName: 'Duolingo::Greek',
  skipAudio: false,
};

const KEY_API_KEY = 'settings:apiKey';
const KEY_DECK_NAME = 'settings:deckName';
const KEY_SKIP_AUDIO = 'settings:skipAudio';

const STORAGE_KEYS = [KEY_API_KEY, KEY_DECK_NAME, KEY_SKIP_AUDIO] as const;

export interface ApiKeyValidation {
  ok: boolean;
  reason?: string;
  warning?: string;
}

export async function loadSettings(storage: Storage): Promise<Settings> {
  const stored = await storage.get([...STORAGE_KEYS]);
  const apiKeyRaw = stored[KEY_API_KEY];
  const deckNameRaw = stored[KEY_DECK_NAME];
  const skipAudioRaw = stored[KEY_SKIP_AUDIO];
  return {
    apiKey: typeof apiKeyRaw === 'string' ? apiKeyRaw : DEFAULT_SETTINGS.apiKey,
    deckName:
      typeof deckNameRaw === 'string' && deckNameRaw.length > 0
        ? deckNameRaw
        : DEFAULT_SETTINGS.deckName,
    skipAudio: typeof skipAudioRaw === 'boolean' ? skipAudioRaw : DEFAULT_SETTINGS.skipAudio,
  };
}

export async function saveSettings(storage: Storage, partial: Partial<Settings>): Promise<void> {
  const writes: Record<string, unknown> = {};
  if (partial.apiKey !== undefined) writes[KEY_API_KEY] = partial.apiKey;
  // An empty deckName would round-trip back to DEFAULT_SETTINGS.deckName on
  // the next load and confuse the user ("I saved nothing — where did my deck
  // name go?"). Skip writing rather than silently substituting the default.
  if (partial.deckName !== undefined && partial.deckName.length > 0) {
    writes[KEY_DECK_NAME] = partial.deckName;
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

export const __test = { KEY_API_KEY, KEY_DECK_NAME, KEY_SKIP_AUDIO, STORAGE_KEYS };
