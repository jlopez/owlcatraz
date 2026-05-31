import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  validateApiKey,
  __test,
} from '../src/lib/settings';
import { memoryStorage } from '../src/lib/enrich';

const { KEY_API_KEY, KEY_DECKS, KEY_LEGACY_DECK_NAME, KEY_SKIP_AUDIO } = __test;

describe('loadSettings', () => {
  it('returns DEFAULT_SETTINGS when storage is empty', async () => {
    const settings = await loadSettings(memoryStorage());
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('merges stored partial values with defaults', async () => {
    const storage = memoryStorage({
      [KEY_API_KEY]: 'sk-ant-stored',
      [KEY_SKIP_AUDIO]: true,
      // decks intentionally absent — should default to {}.
    });
    const settings = await loadSettings(storage);
    expect(settings.apiKey).toBe('sk-ant-stored');
    expect(settings.deckNames).toEqual({});
    expect(settings.skipAudio).toBe(true);
  });

  it('reads a stored decks map', async () => {
    const storage = memoryStorage({
      [KEY_DECKS]: { el: 'Duolingo::Greek::Custom' },
    });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'Duolingo::Greek::Custom' });
  });

  it('filters out non-string and empty entries from a stored decks map', async () => {
    // Defensive: previously-stored data may have stale keys with non-string
    // values (e.g. partial migration from a future version, or corrupted
    // storage). Empty strings semantically mean "no override" and should
    // round-trip to a missing entry rather than a present-but-empty one.
    const storage = memoryStorage({
      [KEY_DECKS]: { el: 'Duolingo::Greek', fr: '', xx: 42 },
    });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'Duolingo::Greek' });
  });
});

describe('loadSettings — legacy migration', () => {
  it('migrates a legacy settings:deckName into deckNames.el when no new map exists', async () => {
    // Pre-multilanguage installs stored a single string under settings:deckName.
    // On first load after upgrade we treat that value as the Greek deck name
    // (the only previously-supported course).
    const storage = memoryStorage({
      [KEY_LEGACY_DECK_NAME]: 'Duolingo::Greek::Custom',
    });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'Duolingo::Greek::Custom' });
  });

  it('prefers the new decks map over the legacy key when both are present', async () => {
    // After the first saveSettings under the new shape, the legacy key
    // lingers as dead data. Authoritative state is the new map.
    const storage = memoryStorage({
      [KEY_LEGACY_DECK_NAME]: 'Duolingo::Greek::Legacy',
      [KEY_DECKS]: { el: 'Duolingo::Greek::New' },
    });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'Duolingo::Greek::New' });
  });

  it('does not migrate an empty legacy value', async () => {
    const storage = memoryStorage({
      [KEY_LEGACY_DECK_NAME]: '',
    });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({});
  });
});

describe('saveSettings', () => {
  it('writes only the keys you pass', async () => {
    const storage = memoryStorage();
    await saveSettings(storage, { apiKey: 'sk-ant-foo' });
    const stored = await storage.get([KEY_API_KEY, KEY_DECKS, KEY_SKIP_AUDIO]);
    expect(Object.keys(stored).sort()).toEqual([KEY_API_KEY]);
    expect(stored[KEY_API_KEY]).toBe('sk-ant-foo');
  });

  it('does not clobber existing deckNames when only apiKey is saved', async () => {
    const storage = memoryStorage({
      [KEY_DECKS]: { el: 'Duolingo::Greek::Custom' },
    });
    await saveSettings(storage, { apiKey: 'sk-ant-foo' });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'Duolingo::Greek::Custom' });
    expect(settings.apiKey).toBe('sk-ant-foo');
  });

  it('overwrites the whole deckNames map when one is provided', async () => {
    // The popup always edits a copy of the loaded settings and saves the
    // full map back, so replacement (not merge) is the right semantic.
    const storage = memoryStorage({
      [KEY_DECKS]: { el: 'old' },
    });
    await saveSettings(storage, { deckNames: { el: 'new' } });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'new' });
  });

  it('drops empty-string entries before writing so they revert to module defaults', async () => {
    // Clearing the deck-name input in the popup should revert that language
    // to its module default on the next load — not persist a stored empty
    // override that would have to be special-cased downstream.
    const storage = memoryStorage();
    await saveSettings(storage, { deckNames: { el: 'Foo', fr: '' } });
    const settings = await loadSettings(storage);
    expect(settings.deckNames).toEqual({ el: 'Foo' });
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
