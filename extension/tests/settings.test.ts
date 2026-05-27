import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateApiKey,
  __test,
} from '../src/lib/settings';
import { memoryStorage } from '../src/lib/enrich';

const { KEY_API_KEY, KEY_DECK_NAME, KEY_SKIP_AUDIO } = __test;

describe('loadSettings', () => {
  it('returns DEFAULT_SETTINGS when storage is empty', async () => {
    const settings = await loadSettings(memoryStorage());
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('merges stored partial values with defaults', async () => {
    const storage = memoryStorage({
      [KEY_API_KEY]: 'sk-ant-stored',
      [KEY_SKIP_AUDIO]: true,
      // deckName intentionally absent — defaults must fill in.
    });
    const settings = await loadSettings(storage);
    expect(settings.apiKey).toBe('sk-ant-stored');
    expect(settings.deckName).toBe(DEFAULT_SETTINGS.deckName);
    expect(settings.skipAudio).toBe(true);
  });
});

describe('saveSettings', () => {
  it('writes only the keys you pass', async () => {
    const storage = memoryStorage();
    await saveSettings(storage, { apiKey: 'sk-ant-foo' });
    const stored = await storage.get([KEY_API_KEY, KEY_DECK_NAME, KEY_SKIP_AUDIO]);
    expect(Object.keys(stored).sort()).toEqual([KEY_API_KEY]);
    expect(stored[KEY_API_KEY]).toBe('sk-ant-foo');
  });

  it('does not clobber an existing deckName when only apiKey is saved', async () => {
    const storage = memoryStorage({
      [KEY_DECK_NAME]: 'Duolingo::Greek::Custom',
    });
    await saveSettings(storage, { apiKey: 'sk-ant-foo' });
    const settings = await loadSettings(storage);
    expect(settings.deckName).toBe('Duolingo::Greek::Custom');
    expect(settings.apiKey).toBe('sk-ant-foo');
  });

  it('skips writing an empty deckName so the value does not silently revert to default', async () => {
    const storage = memoryStorage({
      [KEY_DECK_NAME]: 'Duolingo::Greek::Custom',
    });
    await saveSettings(storage, { deckName: '' });
    const settings = await loadSettings(storage);
    expect(settings.deckName).toBe('Duolingo::Greek::Custom');
  });
});

describe('validateApiKey', () => {
  it('returns ok=false for the empty string', () => {
    const r = validateApiKey('');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/);
  });

  it('returns ok=true with no warning for a well-formed key', () => {
    const r = validateApiKey('sk-ant-anything');
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('returns ok=true with a warning for keys missing the sk-ant- prefix', () => {
    const r = validateApiKey('not-a-key');
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/sk-ant-/);
  });
});
