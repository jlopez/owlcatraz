import { describe, expect, it, vi } from 'vitest';
import {
  __test,
  ankiInvoke,
  ensureDeck,
  ensureNoteType,
  formatPOS,
  syncToAnki,
  type NoteData,
  type SyncOptions,
} from '../src/lib/anki';
import type { Enrichment } from '../src/lib/enrich';
import type { Lexeme } from '../src/types';

const DEFAULT_URL = 'http://127.0.0.1:8765';

interface AnkiRequest {
  action: string;
  version: number;
  params: Record<string, unknown>;
}

type Handler = (params: Record<string, unknown>, req: AnkiRequest) => unknown;

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ankiResponse(result: unknown, error: string | null = null): Response {
  return jsonResponse({ result, error });
}

/**
 * Build a fetch mock that dispatches POSTs by inspecting the AnkiConnect
 * action field. Unmocked actions throw, so tests assert on what they expect.
 * Each handler may return either a raw value (auto-wrapped in {result,error:null})
 * or a Response to override the wrapper entirely.
 */
function mockAnki(handlers: Record<string, Handler>): {
  fetchImpl: typeof fetch;
  calls: { action: string; params: Record<string, unknown> }[];
} {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as AnkiRequest;
    calls.push({ action: body.action, params: body.params });
    const handler = handlers[body.action];
    if (!handler) {
      throw new Error(`Unmocked AnkiConnect action: ${body.action}`);
    }
    const out = handler(body.params, body);
    if (out instanceof Response) return out;
    return ankiResponse(out);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function lex(overrides: Partial<Lexeme> & { text: string }): Lexeme {
  return {
    translations: [],
    audioURL: null,
    isNew: false,
    ...overrides,
  };
}

function enr(overrides: Partial<Enrichment> & { text: string; lemma: string }): Enrichment {
  return {
    pos: 'noun',
    gender: null,
    number: null,
    article: null,
    inflection: null,
    notes: null,
    ...overrides,
  };
}

// modelTemplates handler that mirrors the in-code CARD_TEMPLATES exactly so
// ensureNoteType detects the templates as already-current and does NOT issue
// updateModelTemplates. Use this in tests that don't care about the
// template-self-heal path. Tests that specifically exercise the self-heal
// override modelTemplates with deliberately-stale content.
function currentTemplates(): Record<string, { Front: string; Back: string }> {
  const out: Record<string, { Front: string; Back: string }> = {};
  for (const t of __test.CARD_TEMPLATES) out[t.Name] = { Front: t.Front, Back: t.Back };
  return out;
}

describe('ankiInvoke', () => {
  it('POSTs the configured URL with the right shape and returns the result', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as AnkiRequest;
      expect(body.action).toBe('deckNames');
      expect(body.version).toBe(6);
      expect(body.params).toEqual({});
      return ankiResponse(['Default', 'Duolingo::Greek']);
    }) as unknown as typeof fetch;

    const result = await ankiInvoke<string[]>(
      'deckNames',
      {},
      {
        ankiUrl: 'http://127.0.0.1:9999',
        fetchImpl,
      },
    );
    expect(result).toEqual(['Default', 'Duolingo::Greek']);

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toBe('http://127.0.0.1:9999');
    const init = (calls[0]?.[1] ?? {}) as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  it('throws with the embedded error string when AnkiConnect reports a non-null error', async () => {
    const fetchImpl = vi.fn(async () =>
      ankiResponse(null, 'deck name conflicts'),
    ) as unknown as typeof fetch;
    await expect(ankiInvoke('createDeck', { deck: 'X' }, { fetchImpl })).rejects.toThrow(
      /createDeck.*deck name conflicts/,
    );
  });

  it('throws an actionable error on HTTP failure / connection refused', async () => {
    // HTTP error path.
    const fetchImpl500 = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(ankiInvoke('version', {}, { fetchImpl: fetchImpl500 })).rejects.toThrow(
      /is Anki running with AnkiConnect installed/,
    );
    // Connection-refused / network-error path.
    const fetchImplBoom = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(ankiInvoke('version', {}, { fetchImpl: fetchImplBoom })).rejects.toThrow(
      /is Anki running with the AnkiConnect addon installed/,
    );
  });
});

describe('ensureDeck', () => {
  it('does not call createDeck when the deck already exists', async () => {
    const { fetchImpl, calls } = mockAnki({
      deckNames: () => ['Default', 'Duolingo::Greek'],
      createDeck: () => {
        throw new Error('should not be called');
      },
    });
    await ensureDeck('Duolingo::Greek', { fetchImpl });
    expect(calls.map((c) => c.action)).toEqual(['deckNames']);
  });

  it('calls createDeck exactly once when the deck is missing', async () => {
    const { fetchImpl, calls } = mockAnki({
      deckNames: () => ['Default'],
      createDeck: (params) => {
        expect(params).toEqual({ deck: 'Duolingo::Greek' });
        return 1234567890;
      },
    });
    await ensureDeck('Duolingo::Greek', { fetchImpl });
    expect(calls.map((c) => c.action)).toEqual(['deckNames', 'createDeck']);
  });
});

describe('ensureNoteType', () => {
  it('does not call createModel or updateModelTemplates when model is current', async () => {
    const { fetchImpl, calls } = mockAnki({
      modelNames: () => ['Basic', 'Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      createModel: () => {
        throw new Error('should not be called');
      },
      updateModelTemplates: () => {
        throw new Error('should not be called when templates already match');
      },
    });
    await ensureNoteType('Duolingo Word', { fetchImpl });
    expect(calls.map((c) => c.action)).toEqual(['modelNames', 'modelFieldNames', 'modelTemplates']);
  });

  it('pushes updateModelTemplates when stored templates differ (build version bumped)', async () => {
    // Self-heal: when the user's deck already has the note type but the
    // template HTML has drifted (e.g. BUILD_VERSION bumped to swap
    // {{type:Target}} for {{type:TargetWithArticle}}), push the new
    // templates. updateModelTemplates re-renders existing cards without
    // touching scheduling history.
    let updatePayload: Record<string, unknown> | null = null;
    const { fetchImpl } = mockAnki({
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => ({
        Recognition: { Front: 'OUTDATED', Back: 'OUTDATED' },
        Production: { Front: 'OUTDATED', Back: 'OUTDATED' },
      }),
      updateModelTemplates: (params) => {
        updatePayload = params;
        return null;
      },
      createModel: () => {
        throw new Error('should not be called');
      },
    });
    await ensureNoteType('Duolingo Word', { fetchImpl });
    expect(updatePayload).not.toBeNull();
    const p = updatePayload as unknown as {
      model: { name: string; templates: Record<string, { Front: string; Back: string }> };
    };
    expect(p.model.name).toBe('Duolingo Word');
    expect(p.model.templates['Recognition']?.Front).toContain('{{type:TargetWithArticle}}');
    expect(p.model.templates['Production']?.Front).toContain('{{TargetWithArticle}}');
  });

  it('throws an actionable error when an existing model has different fields', async () => {
    const { fetchImpl } = mockAnki({
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => ['Front', 'Back'],
      createModel: () => {
        throw new Error('should not be called');
      },
      updateModelTemplates: () => {
        throw new Error('should not be reached: should throw on field-shape mismatch first');
      },
    });
    await expect(ensureNoteType('Duolingo Word', { fetchImpl })).rejects.toThrow(
      /already exists but its fields do not match.*Front, Back/,
    );
  });

  it('createModel payload matches the spec (inOrderFields, css, cardTemplates)', async () => {
    let captured: Record<string, unknown> | null = null;
    const { fetchImpl } = mockAnki({
      modelNames: () => ['Basic'],
      createModel: (params) => {
        captured = params;
        return null;
      },
    });
    await ensureNoteType('Duolingo Word', { fetchImpl });
    expect(captured).not.toBeNull();
    const p = captured as unknown as {
      modelName: string;
      inOrderFields: string[];
      css: string;
      isCloze: boolean;
      cardTemplates: { Name: string; Front: string; Back: string }[];
    };
    expect(p.modelName).toBe('Duolingo Word');
    expect(p.inOrderFields).toEqual([
      'LemmaKey',
      'Language',
      'English',
      'Target',
      'TargetWithArticle',
      'Lemma',
      'POS',
      'Inflection',
      'Notes',
      'Audio',
    ]);
    expect(p.isCloze).toBe(false);
    expect(p.css).toBe(__test.NOTE_TYPE_CSS);
    expect(p.cardTemplates).toHaveLength(2);
    expect(p.cardTemplates[0]?.Name).toBe('Recognition');
    // Typing prompt is article-prefixed: learner internalizes gender with the
    // noun. TargetWithArticle === Target when there is no article.
    expect(p.cardTemplates[0]?.Front).toContain('{{type:TargetWithArticle}}');
    expect(p.cardTemplates[0]?.Front).not.toContain('{{type:Target}}');
    expect(p.cardTemplates[0]?.Back).toContain('{{FrontSide}}');
    expect(p.cardTemplates[0]?.Back).toContain('{{TargetWithArticle}}');
    expect(p.cardTemplates[1]?.Name).toBe('Production');
    expect(p.cardTemplates[1]?.Front).toContain('{{TargetWithArticle}}');
    expect(p.cardTemplates[1]?.Back).toContain('{{English}}');
    expect(p).toEqual(p); // snapshot-style: fail-loud if shape drifts
  });
});

describe('formatPOS', () => {
  it.each([
    [
      enr({ text: 'σκύλος', lemma: 'σκύλος', pos: 'noun', gender: 'm', number: 'singular' }),
      'noun (masc., sing.)',
    ],
    [
      enr({ text: 'γυναίκες', lemma: 'γυναίκα', pos: 'noun', gender: 'f', number: 'plural' }),
      'noun (fem., pl.)',
    ],
    [
      enr({ text: 'παιδί', lemma: 'παιδί', pos: 'noun', gender: 'n', number: 'singular' }),
      'noun (neut., sing.)',
    ],
    [enr({ text: 'someone', lemma: 'x', pos: 'noun' }), 'noun'],
    [enr({ text: 'διαβάζω', lemma: 'διαβάζω', pos: 'verb' }), 'verb'],
    [enr({ text: 'καλός', lemma: 'καλός', pos: 'adjective' }), 'adjective'],
    [enr({ text: 'γρήγορα', lemma: 'γρήγορα', pos: 'adverb' }), 'adverb'],
    [enr({ text: 'εγώ', lemma: 'εγώ', pos: 'pronoun' }), 'pronoun'],
    [enr({ text: 'οι', lemma: 'οι', pos: 'article' }), 'article'],
    [enr({ text: 'με συγχωρείτε', lemma: 'με συγχωρείτε', pos: 'phrase' }), 'phrase'],
    [enr({ text: 'να', lemma: 'να', pos: 'particle' }), 'particle'],
    [enr({ text: 'foo', lemma: 'foo', pos: 'other' }), 'other'],
  ])('formats %o as "%s"', (enrichment, expected) => {
    expect(formatPOS(enrichment)).toBe(expected);
  });
});

describe('syncToAnki — happy path', () => {
  it('runs the full version → ensure → store-media → addNotes sequence', async () => {
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({
          text: 'σκύλος',
          translations: ['dog'],
          audioURL: 'https://duo.example/audio/skylos.mp3',
        }),
        enrichment: enr({
          text: 'σκύλος',
          lemma: 'σκύλος',
          pos: 'noun',
          gender: 'm',
          number: 'singular',
          article: 'ο',
        }),
      },
      {
        language: 'el',
        lexeme: lex({ text: 'διαβάζω', translations: ['I read'] }),
        enrichment: enr({
          text: 'διαβάζω',
          lemma: 'διαβάζω',
          pos: 'verb',
          inflection: '1sg present',
        }),
      },
      {
        language: 'el',
        lexeme: lex({ text: 'με συγχωρείτε', translations: ['excuse me'] }),
        enrichment: enr({
          text: 'με συγχωρείτε',
          lemma: 'με συγχωρείτε',
          pos: 'phrase',
          notes: 'polite "excuse me"',
        }),
      },
    ];

    let storeMediaCount = 0;
    let storeMediaPayload: Record<string, unknown> | null = null;
    let addNotesPayload: Record<string, unknown> | null = null;
    const { fetchImpl, calls } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      storeMediaFile: (params) => {
        storeMediaCount += 1;
        storeMediaPayload = params;
        return params['filename'] as string;
      },
      addNotes: (params) => {
        addNotesPayload = params;
        return [1001, 1002, 1003];
      },
    });

    const audioFetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4, 5])),
    ) as unknown as typeof fetch;

    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
      audioFetchImpl,
    });

    expect(result).toEqual({
      added: 3,
      skipped: 0,
      updated: 0,
      audioStored: 1,
      audioFailed: 0,
      failed: [],
    });

    // Counts per action.
    const actionCounts = calls.reduce<Record<string, number>>((acc, c) => {
      acc[c.action] = (acc[c.action] ?? 0) + 1;
      return acc;
    }, {});
    expect(actionCounts['version']).toBe(1);
    expect(actionCounts['deckNames']).toBe(1);
    expect(actionCounts['modelNames']).toBe(1);
    expect(actionCounts['addNotes']).toBe(1);
    expect(storeMediaCount).toBe(1);

    // Audio file is named deterministically by SHA-256 of the URL.
    expect(storeMediaPayload).not.toBeNull();
    const sp = storeMediaPayload as unknown as { filename: string; data: string };
    expect(sp.filename).toMatch(/^duolingo_[0-9a-f]{64}\.mp3$/);
    // base64 of [1,2,3,4,5] = AQIDBAU=
    expect(sp.data).toBe('AQIDBAU=');

    // addNotes received all 3 notes in input order.
    expect(addNotesPayload).not.toBeNull();
    const ap = addNotesPayload as unknown as {
      notes: { fields: Record<string, string>; tags: string[]; deckName: string }[];
    };
    expect(ap.notes).toHaveLength(3);
    expect(ap.notes[0]?.deckName).toBe('Duolingo::Greek');
    // New notes carry the current build tag so the next sync can short-circuit.
    expect(ap.notes[0]?.tags).toEqual(['duolingo', 'el', __test.BUILD_TAG_CURRENT]);
    expect(ap.notes[0]?.fields['LemmaKey']).toBe('el:σκύλος:σκύλος');
    expect(ap.notes[0]?.fields['TargetWithArticle']).toBe('ο σκύλος');
    expect(ap.notes[0]?.fields['POS']).toBe('noun (masc., sing.)');
    expect(ap.notes[0]?.fields['Audio']).toBe(sp.filename ? `[sound:${sp.filename}]` : '');
    expect(ap.notes[1]?.fields['Audio']).toBe('');
    expect(ap.notes[1]?.fields['Inflection']).toBe('1sg present');
    expect(ap.notes[1]?.fields['POS']).toBe('verb');
    expect(ap.notes[2]?.fields['POS']).toBe('phrase');
    expect(ap.notes[2]?.fields['English']).toContain('excuse me');
    expect(ap.notes[2]?.fields['English']).toContain('polite');

    expect(audioFetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('syncToAnki — preflight duplicate skip', () => {
  it('skips notes already in the deck before fetching audio or calling addNotes', async () => {
    // Second-sync hot path. The preflight findNotes+notesInfo enumerates
    // existing LemmaKeys; matching inputs are dropped before audio fetch.
    // Without this, every re-sync re-downloads every MP3 and re-uploads
    // every note before discovering the duplicates.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'a', audioURL: 'https://duo.example/a.mp3' }),
        enrichment: enr({ text: 'a', lemma: 'a' }),
      },
      {
        language: 'el',
        lexeme: lex({ text: 'b', audioURL: 'https://duo.example/b.mp3' }),
        enrichment: enr({ text: 'b', lemma: 'b' }),
      },
      {
        language: 'el',
        lexeme: lex({ text: 'c', audioURL: 'https://duo.example/c.mp3' }),
        enrichment: enr({ text: 'c', lemma: 'c' }),
      },
    ];
    let addNotesPayload: Record<string, unknown> | null = null;
    let findNotesQuery: string | undefined;
    const audioFetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch;
    const { fetchImpl, calls } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: (params) => {
        findNotesQuery = params['query'] as string;
        return [42];
      },
      notesInfo: () => [
        {
          noteId: 42,
          modelName: 'Duolingo Word',
          // Build tag is current → preflight skip without fields rebuild.
          tags: ['duolingo', 'el', __test.BUILD_TAG_CURRENT],
          fields: {
            LemmaKey: { value: 'el:b:b', order: 0 },
          },
        },
      ],
      storeMediaFile: (params) => params['filename'] as string,
      addNotes: (params) => {
        addNotesPayload = params;
        return [12345, 67890];
      },
    });
    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
      audioFetchImpl,
    });
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([]);
    // Preflight scopes by deck AND model so we don't trip over notes from
    // other note types the user has in the same deck.
    expect(findNotesQuery).toBe('deck:"Duolingo::Greek" note:"Duolingo Word"');
    // Audio fetched only for the two non-skipped notes.
    expect(audioFetchImpl).toHaveBeenCalledTimes(2);
    // addNotes batch contains only a and c — b was dropped upfront.
    const ap = addNotesPayload as unknown as {
      notes: { fields: Record<string, string> }[];
    };
    expect(ap.notes.map((n) => n.fields['LemmaKey'])).toEqual(['el:a:a', 'el:c:c']);
    // storeMediaFile called twice (a and c), not three times.
    const storeCount = calls.filter((c) => c.action === 'storeMediaFile').length;
    expect(storeCount).toBe(2);
  });

  it('correctly skips phrase keys with spaces in the preflight set', async () => {
    // Regression: phrase lemma keys (e.g. "el:με συγχωρείτε:…") contain
    // spaces. The preflight match is a plain Set lookup on string values
    // returned by notesInfo, so spaces don't need special handling — but
    // pin this behavior with a test so a future search-syntax refactor
    // can't silently break it.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'με συγχωρείτε' }),
        enrichment: enr({ text: 'με συγχωρείτε', lemma: 'με συγχωρείτε', pos: 'phrase' }),
      },
    ];
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [99],
      notesInfo: () => [
        {
          noteId: 99,
          modelName: 'Duolingo Word',
          tags: ['duolingo', 'el', __test.BUILD_TAG_CURRENT],
          fields: {
            LemmaKey: {
              value: 'el:με συγχωρείτε:με συγχωρείτε',
              order: 0,
            },
          },
        },
      ],
      addNotes: () => {
        throw new Error('addNotes should not be reached — note is a duplicate');
      },
    });
    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
    });
    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
  });
});

describe('syncToAnki — build-version auto-heal', () => {
  it('updates fields in place (preserves noteId) when build tag is older', async () => {
    // Critical invariant: when a heuristic fix changes a note's content, we
    // call updateNoteFields on the EXISTING noteId. Anki keeps scheduling
    // history per-card, and cards stay attached to the note — so the user's
    // review progress is preserved across the heal.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'σκύλοι', translations: ['dogs'] }),
        enrichment: enr({
          text: 'σκύλοι',
          lemma: 'σκύλος',
          pos: 'noun',
          gender: 'm',
          number: 'plural',
          article: 'οι',
          inflection: 'plural of σκύλος',
        }),
      },
    ];
    let updateNotePayload: Record<string, unknown> | null = null;
    let updateTagsPayload: Record<string, unknown> | null = null;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [777],
      notesInfo: () => [
        {
          noteId: 777,
          modelName: 'Duolingo Word',
          // No build tag → treated as pre-BUILD_VERSION (e.g. v1 sync that
          // synthesized neuter-singular by mistake).
          tags: ['duolingo', 'el'],
          fields: {
            LemmaKey: { value: 'el:σκύλος:σκύλοι', order: 0 },
            Language: { value: 'el', order: 1 },
            English: { value: 'dogs', order: 2 },
            Target: { value: 'σκύλοι', order: 3 },
            TargetWithArticle: { value: 'το σκύλοι', order: 4 }, // ← old, wrong
            Lemma: { value: 'σκύλοι', order: 5 }, // ← old, wrong
            POS: { value: 'noun (neut., sing.)', order: 6 }, // ← old, wrong
            Inflection: { value: '', order: 7 },
            Notes: { value: '', order: 8 },
            Audio: { value: '', order: 9 },
          },
        },
      ],
      updateNoteFields: (params) => {
        updateNotePayload = params;
        return null;
      },
      updateNoteTags: (params) => {
        updateTagsPayload = params;
        return null;
      },
      addNotes: () => {
        throw new Error('addNotes must NOT be called on the update path');
      },
    });
    const result = await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl });
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.updated).toBe(1);

    expect(updateNotePayload).not.toBeNull();
    const up = updateNotePayload as unknown as {
      note: { id: number; fields: Record<string, string> };
    };
    // Note ID preserved — same review history.
    expect(up.note.id).toBe(777);
    // Fields rebuilt with corrected enrichment.
    expect(up.note.fields['TargetWithArticle']).toBe('οι σκύλοι');
    expect(up.note.fields['Lemma']).toBe('σκύλος');
    expect(up.note.fields['POS']).toBe('noun (masc., pl.)');

    expect(updateTagsPayload).not.toBeNull();
    const tp = updateTagsPayload as unknown as { note: number; tags: string[] };
    expect(tp.note).toBe(777);
    expect(tp.tags).toContain(__test.BUILD_TAG_CURRENT);
    expect(tp.tags).toContain('duolingo');
    expect(tp.tags).toContain('el');
  });

  it('skips updateNoteFields when fields are byte-identical but still bumps the tag', async () => {
    // Field-equality short-circuit: a note whose content didn't change between
    // BUILD_VERSION bumps shouldn't show up as a modified note in AnkiWeb
    // sync. We still issue updateNoteTags so the next sync short-circuits
    // earlier.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'γάντι', translations: ['glove'] }),
        enrichment: enr({
          text: 'γάντι',
          lemma: 'γάντι',
          pos: 'noun',
          gender: 'n',
          number: 'singular',
          article: 'το',
        }),
      },
    ];
    let updateNoteFieldsCalls = 0;
    let updateTagsCalls = 0;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [555],
      notesInfo: () => [
        {
          noteId: 555,
          modelName: 'Duolingo Word',
          tags: ['duolingo', 'el'], // older build, no current tag
          fields: {
            LemmaKey: { value: 'el:γάντι:γάντι', order: 0 },
            Language: { value: 'el', order: 1 },
            English: { value: 'glove', order: 2 },
            Target: { value: 'γάντι', order: 3 },
            TargetWithArticle: { value: 'το γάντι', order: 4 },
            Lemma: { value: 'γάντι', order: 5 },
            POS: { value: 'noun (neut., sing.)', order: 6 },
            Inflection: { value: '', order: 7 },
            Notes: { value: '', order: 8 },
            Audio: { value: '', order: 9 },
          },
        },
      ],
      updateNoteFields: () => {
        updateNoteFieldsCalls += 1;
        return null;
      },
      updateNoteTags: () => {
        updateTagsCalls += 1;
        return null;
      },
      addNotes: () => {
        throw new Error('addNotes must NOT be called on the update path');
      },
    });
    const result = await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl });
    expect(updateNoteFieldsCalls).toBe(0); // no-op write avoided
    expect(updateTagsCalls).toBe(1); // tag still advances
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1); // counts as a skip from the user's POV
  });

  it("strips stale build tags so notes don't accumulate one per version", async () => {
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'a' }),
        enrichment: enr({ text: 'a', lemma: 'a' }),
      },
    ];
    let updateTagsPayload: Record<string, unknown> | null = null;
    let updateNoteFieldsCalls = 0;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [1],
      notesInfo: () => [
        {
          noteId: 1,
          modelName: 'Duolingo Word',
          // Imagine a user who upgraded through several versions. Also
          // includes a non-numeric "owlcatraz:build:in-review" tag the user
          // added manually — narrower regex should preserve it.
          tags: [
            'duolingo',
            'el',
            'owlcatraz:build:1',
            'owlcatraz:build:0',
            'owlcatraz:build:in-review',
            'custom',
          ],
          fields: {
            LemmaKey: { value: 'el:a:a', order: 0 },
            Language: { value: 'el', order: 1 },
            English: { value: '', order: 2 },
            Target: { value: 'a', order: 3 },
            TargetWithArticle: { value: 'a', order: 4 },
            Lemma: { value: 'a', order: 5 },
            POS: { value: 'noun', order: 6 },
            Inflection: { value: '', order: 7 },
            Notes: { value: '', order: 8 },
            Audio: { value: '', order: 9 },
          },
        },
      ],
      updateNoteFields: () => {
        updateNoteFieldsCalls += 1;
        return null;
      },
      updateNoteTags: (params) => {
        updateTagsPayload = params;
        return null;
      },
      addNotes: () => {
        throw new Error('addNotes should not be reached');
      },
    });
    await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl });
    // Fields are byte-identical → no-op write avoided (exercises fieldsEqual
    // short-circuit + asserts the test isn't passing for the wrong reason).
    expect(updateNoteFieldsCalls).toBe(0);
    expect(updateTagsPayload).not.toBeNull();
    const tp = updateTagsPayload as unknown as { tags: string[] };
    // Stale numeric build tags removed, custom user tags preserved (including
    // the non-numeric `owlcatraz:build:in-review`), current build tag added.
    expect(tp.tags).not.toContain('owlcatraz:build:0');
    expect(tp.tags).not.toContain('owlcatraz:build:1');
    expect(tp.tags).toContain(__test.BUILD_TAG_CURRENT);
    expect(tp.tags).toContain('custom');
    expect(tp.tags).toContain('owlcatraz:build:in-review');
    // No duplicates.
    expect(new Set(tp.tags).size).toBe(tp.tags.length);
  });

  it('isolates per-note update failures (one bad note does not kill the heal)', async () => {
    // Matches the addNotes path's per-null classification: a single
    // updateNoteFields error must be recorded in result.failed and the loop
    // must continue with the remaining notes. Previously a throw aborted the
    // whole sync — a regression vs. addNotes resilience.
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
      { language: 'el', lexeme: lex({ text: 'b' }), enrichment: enr({ text: 'b', lemma: 'b' }) },
      { language: 'el', lexeme: lex({ text: 'c' }), enrichment: enr({ text: 'c', lemma: 'c' }) },
    ];
    const noteInfo = (id: number, key: string, text: string) => ({
      noteId: id,
      modelName: 'Duolingo Word',
      tags: ['duolingo', 'el'], // older build → all three go to update path
      fields: {
        LemmaKey: { value: key, order: 0 },
        Language: { value: 'el', order: 1 },
        English: { value: '', order: 2 },
        Target: { value: text, order: 3 },
        TargetWithArticle: { value: text, order: 4 },
        Lemma: { value: text, order: 5 },
        // Wrong POS forces fieldsEqual=false so updateNoteFields is actually
        // called (the fresh buildFields produces POS='noun' for our enr()).
        POS: { value: 'noun (neut., sing.)', order: 6 },
        Inflection: { value: '', order: 7 },
        Notes: { value: '', order: 8 },
        Audio: { value: '', order: 9 },
      },
    });
    let updateCalls = 0;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [1, 2, 3],
      notesInfo: () => [
        noteInfo(1, 'el:a:a', 'a'),
        noteInfo(2, 'el:b:b', 'b'),
        noteInfo(3, 'el:c:c', 'c'),
      ],
      updateNoteFields: (params) => {
        updateCalls += 1;
        const id = (params['note'] as { id: number }).id;
        if (id === 2) {
          return ankiResponse(null, 'note has invalid fields');
        }
        return null;
      },
      updateNoteTags: () => null,
      addNotes: () => {
        throw new Error('addNotes should not be reached on the update path');
      },
    });
    const result = await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl });
    // All three notes were attempted (no early-abort).
    expect(updateCalls).toBe(3);
    // Note b failed and is recorded; a and c succeeded.
    expect(result.updated).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.lemmaKey).toBe('el:b:b');
    expect(result.failed[0]?.reason).toMatch(/update failed.*invalid fields/);
  });

  it('preserves existing Audio field on update (avoids re-downloading MP3)', async () => {
    // Re-fetching every MP3 just because we bumped BUILD_VERSION is wasteful
    // and inflates audioStored counts. The existing [sound:…] reference stays.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({
          text: 'σκύλος',
          translations: ['dog'],
          audioURL: 'https://duo.example/skylos.mp3',
        }),
        enrichment: enr({ text: 'σκύλος', lemma: 'σκύλος', pos: 'noun' }),
      },
    ];
    let storeMediaCalled = false;
    let updateNotePayload: Record<string, unknown> | null = null;
    const audioFetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [11],
      notesInfo: () => [
        {
          noteId: 11,
          modelName: 'Duolingo Word',
          tags: ['duolingo', 'el'], // older build
          fields: {
            LemmaKey: { value: 'el:σκύλος:σκύλος', order: 0 },
            Language: { value: 'el', order: 1 },
            English: { value: 'old english value', order: 2 },
            Target: { value: 'σκύλος', order: 3 },
            TargetWithArticle: { value: 'σκύλος', order: 4 },
            Lemma: { value: 'σκύλος', order: 5 },
            POS: { value: 'noun', order: 6 },
            Inflection: { value: '', order: 7 },
            Notes: { value: '', order: 8 },
            Audio: { value: '[sound:duolingo_existing.mp3]', order: 9 },
          },
        },
      ],
      storeMediaFile: () => {
        storeMediaCalled = true;
        return 'should-not-fire.mp3';
      },
      updateNoteFields: (params) => {
        updateNotePayload = params;
        return null;
      },
      updateNoteTags: () => null,
      addNotes: () => {
        throw new Error('addNotes must NOT be called on the update path');
      },
    });
    await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl, audioFetchImpl });
    expect(audioFetchImpl).not.toHaveBeenCalled();
    expect(storeMediaCalled).toBe(false);
    expect(updateNotePayload).not.toBeNull();
    const up = updateNotePayload as unknown as { note: { fields: Record<string, string> } };
    expect(up.note.fields['Audio']).toBe('[sound:duolingo_existing.mp3]');
  });
});

describe('syncToAnki — addNotes fallback for nulls (preflight miss)', () => {
  it('post-addNotes findNotes still classifies stray null ids as skipped', async () => {
    // Defensive path: if a note slipped past the preflight (e.g. created in
    // Anki between our preflight and addNotes calls), addNotes returns a
    // null for it and the per-null findNotes lookup confirms the existing
    // note → skipped, not failed. Branch the mock on query shape rather
    // than call count: preflight uses `note:"Duolingo Word"`, confirmation
    // uses `LemmaKey:"…"` — distinguishable without ordering coupling.
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
      { language: 'el', lexeme: lex({ text: 'b' }), enrichment: enr({ text: 'b', lemma: 'b' }) },
    ];
    let preflightCalls = 0;
    let confirmationQuery: string | undefined;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: (params) => {
        const query = params['query'] as string;
        if (query.includes('LemmaKey:')) {
          confirmationQuery = query;
          return [42];
        }
        preflightCalls += 1;
        return [];
      },
      addNotes: () => [12345, null],
    });
    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
    });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([]);
    expect(preflightCalls).toBe(1);
    expect(confirmationQuery).toBe('deck:"Duolingo::Greek" LemmaKey:"el:b:b"');
  });
});

describe('syncToAnki — LemmaKey uniqueness across inflections', () => {
  it('emits distinct LemmaKeys for surface forms that share a lemma', async () => {
    // Regression: 294 fixture lexemes collapsed to 252 unique LemmaKeys when
    // the key was just `${language}:${lemma}`, because Duolingo teaches
    // multiple inflected forms of the same lemma (διαβάζω / διαβάζεις /
    // διαβάζετε all share lemma διαβάζω). Anki rejected the in-batch
    // collisions and rolled back the entire addNotes call.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'διαβάζω' }),
        enrichment: enr({ text: 'διαβάζω', lemma: 'διαβάζω', pos: 'verb' }),
      },
      {
        language: 'el',
        lexeme: lex({ text: 'διαβάζεις' }),
        enrichment: enr({
          text: 'διαβάζεις',
          lemma: 'διαβάζω',
          pos: 'verb',
          inflection: '2sg present of διαβάζω',
        }),
      },
      {
        language: 'el',
        lexeme: lex({ text: 'διαβάζετε' }),
        enrichment: enr({
          text: 'διαβάζετε',
          lemma: 'διαβάζω',
          pos: 'verb',
          inflection: '2pl present of διαβάζω',
        }),
      },
    ];
    let addNotesPayload: Record<string, unknown> | null = null;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      addNotes: (params) => {
        addNotesPayload = params;
        return [1, 2, 3];
      },
    });
    const result = await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl });
    expect(result.added).toBe(3);
    const ap = addNotesPayload as unknown as { notes: { fields: Record<string, string> }[] };
    const keys = ap.notes.map((n) => n.fields['LemmaKey']);
    expect(keys).toEqual(['el:διαβάζω:διαβάζω', 'el:διαβάζω:διαβάζεις', 'el:διαβάζω:διαβάζετε']);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('syncToAnki — addNotes returns top-level error on all-duplicate batch', () => {
  it('classifies the batch as skipped when the rolled-back error matches batch size', async () => {
    // Second-sync hot path: every note is a deck-level duplicate, AnkiConnect
    // rolls back the batch and surfaces `result: null, error: "['cannot
    // create note because it is a duplicate', ...]"` (one msg per note).
    // The findNotes-based per-note classifier below must then confirm each
    // null as an actual existing note → result.skipped, not result.failed.
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
      { language: 'el', lexeme: lex({ text: 'b' }), enrichment: enr({ text: 'b', lemma: 'b' }) },
      { language: 'el', lexeme: lex({ text: 'c' }), enrichment: enr({ text: 'c', lemma: 'c' }) },
    ];
    const dupList =
      "['cannot create note because it is a duplicate', " +
      "'cannot create note because it is a duplicate', " +
      "'cannot create note because it is a duplicate']";
    let findNotesCallCount = 0;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      addNotes: () => ankiResponse(null, dupList),
      // Preflight returns [] (defensive simulation: pretend the preflight
      // missed these), then each per-null confirmation returns the existing
      // note id.
      findNotes: () => {
        findNotesCallCount += 1;
        return findNotesCallCount === 1 ? [] : [42];
      },
    });
    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
    });
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('rethrows when the duplicate-message count does not match batch size', async () => {
    // Partial failure (in-batch duplicate collisions): without a way to map
    // messages back to specific notes, surface the original error rather than
    // silently dropping unknown failures.
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
      { language: 'el', lexeme: lex({ text: 'b' }), enrichment: enr({ text: 'b', lemma: 'b' }) },
      { language: 'el', lexeme: lex({ text: 'c' }), enrichment: enr({ text: 'c', lemma: 'c' }) },
    ];
    const dupList = "['cannot create note because it is a duplicate']";
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      addNotes: () => ankiResponse(null, dupList),
    });
    await expect(syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl })).rejects.toThrow(
      /addNotes.*duplicate/,
    );
  });

  it('rethrows on non-duplicate error strings (e.g. deck missing)', async () => {
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
    ];
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      addNotes: () => ankiResponse(null, 'deck was not found'),
    });
    await expect(syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl })).rejects.toThrow(
      /addNotes.*deck was not found/,
    );
  });
});

describe('syncToAnki — failure when no duplicate exists', () => {
  it('records a failure when addNotes returns null but findNotes returns []', async () => {
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
    ];
    let findNotesCallCount = 0;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      addNotes: () => [null],
      // Preflight then per-null confirmation; both return [].
      findNotes: () => {
        findNotesCallCount += 1;
        return [];
      },
    });
    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
    });
    expect(findNotesCallCount).toBe(2);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.lemmaKey).toBe('el:a:a');
    expect(result.failed[0]?.reason).toMatch(/no existing note found/);
  });
});

describe('syncToAnki — audio fetch failure', () => {
  it('still adds the note (with empty Audio) and bumps audioFailed', async () => {
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({
          text: 'σκύλος',
          translations: ['dog'],
          audioURL: 'https://duo.example/missing.mp3',
        }),
        enrichment: enr({
          text: 'σκύλος',
          lemma: 'σκύλος',
          pos: 'noun',
          gender: 'm',
          article: 'ο',
        }),
      },
    ];
    let addNotesPayload: Record<string, unknown> | null = null;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      // storeMediaFile must NOT be called when the audio fetch fails.
      storeMediaFile: () => {
        throw new Error('should not be called');
      },
      addNotes: (params) => {
        addNotesPayload = params;
        return [9999];
      },
    });
    const audioFetchImpl = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch;
    const result = await syncToAnki(notes, {
      deckName: 'Duolingo::Greek',
      fetchImpl,
      audioFetchImpl,
    });
    expect(result.added).toBe(1);
    expect(result.audioStored).toBe(0);
    expect(result.audioFailed).toBe(1);
    const ap = addNotesPayload as unknown as {
      notes: { fields: Record<string, string> }[];
    };
    expect(ap.notes[0]?.fields['Audio']).toBe('');
  });
});

describe('syncToAnki — skipAudio:true', () => {
  it('does not call audioFetchImpl or storeMediaFile and emits empty Audio fields', async () => {
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({
          text: 'σκύλος',
          translations: ['dog'],
          audioURL: 'https://duo.example/skylos.mp3',
        }),
        enrichment: enr({ text: 'σκύλος', lemma: 'σκύλος', pos: 'noun' }),
      },
    ];
    let addNotesPayload: Record<string, unknown> | null = null;
    const audioFetchImpl = vi.fn() as unknown as typeof fetch;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      storeMediaFile: () => {
        throw new Error('should not be called');
      },
      addNotes: (params) => {
        addNotesPayload = params;
        return [777];
      },
    });
    const opts: SyncOptions = {
      deckName: 'Duolingo::Greek',
      fetchImpl,
      audioFetchImpl,
      skipAudio: true,
    };
    const result = await syncToAnki(notes, opts);
    expect(audioFetchImpl).not.toHaveBeenCalled();
    expect(result.added).toBe(1);
    expect(result.audioStored).toBe(0);
    expect(result.audioFailed).toBe(0);
    const ap = addNotesPayload as unknown as {
      notes: { fields: Record<string, string> }[];
    };
    expect(ap.notes[0]?.fields['Audio']).toBe('');
  });
});

describe('syncToAnki — empty input', () => {
  it('still runs version/deck/model checks but never calls addNotes or storeMediaFile', async () => {
    const { fetchImpl, calls } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      addNotes: () => {
        throw new Error('should not be called');
      },
      storeMediaFile: () => {
        throw new Error('should not be called');
      },
    });
    const result = await syncToAnki([], {
      deckName: 'Duolingo::Greek',
      fetchImpl,
    });
    expect(result).toEqual({
      added: 0,
      skipped: 0,
      updated: 0,
      audioStored: 0,
      audioFailed: 0,
      failed: [],
    });
    expect(calls.map((c) => c.action)).toEqual([
      'version',
      'deckNames',
      'modelNames',
      'modelFieldNames',
      'modelTemplates',
    ]);
  });
});

describe('syncToAnki — version gate', () => {
  it('throws an actionable error if AnkiConnect version < 6', async () => {
    const { fetchImpl } = mockAnki({
      version: () => 5,
    });
    await expect(syncToAnki([], { deckName: 'Duolingo::Greek', fetchImpl })).rejects.toThrow(
      /AnkiConnect.*version 5.*6\+/,
    );
  });
});

describe('syncToAnki — storeMediaFile failure is not swallowed', () => {
  it('propagates a storeMediaFile error so the user learns AnkiConnect is broken', async () => {
    // Distinct from audio-fetch failure: audio download succeeds, but the
    // AnkiConnect call to persist the file errors out. Silently bumping
    // audioFailed for every note would mask Anki being down.
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({
          text: 'σκύλος',
          translations: ['dog'],
          audioURL: 'https://duo.example/audio/skylos.mp3',
        }),
        enrichment: enr({ text: 'σκύλος', lemma: 'σκύλος', pos: 'noun' }),
      },
    ];
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      storeMediaFile: () => {
        // Simulate an AnkiConnect-level failure (e.g. media folder missing).
        return new Response(JSON.stringify({ result: null, error: 'cannot store media' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      addNotes: () => {
        throw new Error('should not be reached');
      },
    });
    const audioFetchImpl = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch;
    await expect(
      syncToAnki(notes, {
        deckName: 'Duolingo::Greek',
        fetchImpl,
        audioFetchImpl,
      }),
    ).rejects.toThrow(/storeMediaFile.*cannot store media/);
  });
});

describe('syncToAnki — addNotes length mismatch', () => {
  it('throws when AnkiConnect returns fewer ids than notes sent', async () => {
    const notes: NoteData[] = [
      { language: 'el', lexeme: lex({ text: 'a' }), enrichment: enr({ text: 'a', lemma: 'a' }) },
      { language: 'el', lexeme: lex({ text: 'b' }), enrichment: enr({ text: 'b', lemma: 'b' }) },
      { language: 'el', lexeme: lex({ text: 'c' }), enrichment: enr({ text: 'c', lemma: 'c' }) },
    ];
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      addNotes: () => [1, 2],
    });
    await expect(syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl })).rejects.toThrow(
      /returned 2 entries; expected 3/,
    );
  });
});

describe('syncToAnki — empty enrichment.notes', () => {
  it('treats an empty-string notes value the same as null (no " — " suffix)', async () => {
    const notes: NoteData[] = [
      {
        language: 'el',
        lexeme: lex({ text: 'σκύλος', translations: ['dog'] }),
        enrichment: enr({ text: 'σκύλος', lemma: 'σκύλος', pos: 'noun', notes: '' }),
      },
    ];
    let addNotesPayload: Record<string, unknown> | null = null;
    const { fetchImpl } = mockAnki({
      version: () => 6,
      deckNames: () => ['Duolingo::Greek'],
      modelNames: () => ['Duolingo Word'],
      modelFieldNames: () => [...__test.NOTE_TYPE_FIELDS],
      modelTemplates: () => currentTemplates(),
      findNotes: () => [],
      addNotes: (params) => {
        addNotesPayload = params;
        return [1];
      },
    });
    await syncToAnki(notes, { deckName: 'Duolingo::Greek', fetchImpl });
    const ap = addNotesPayload as unknown as {
      notes: { fields: Record<string, string> }[];
    };
    expect(ap.notes[0]?.fields['English']).toBe('dog');
    expect(ap.notes[0]?.fields['Notes']).toBe('');
  });
});

describe('syncToAnki — defaults', () => {
  it('defaults to model name "Duolingo Word" and URL ' + DEFAULT_URL, () => {
    expect(__test.DEFAULT_MODEL_NAME).toBe('Duolingo Word');
    expect(__test.DEFAULT_ANKI_URL).toBe(DEFAULT_URL);
  });
});
