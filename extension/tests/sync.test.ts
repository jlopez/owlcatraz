import { describe, expect, it, vi } from 'vitest';
import { runFullSync, type SyncProgress, type SyncStep } from '../src/lib/sync';
import { memoryStorage } from '../src/lib/enrich';
import type { Lexeme, LexemesPage } from '../src/types';

// JWT for userId "42" — base64url-encoded payload {"sub":42}.
function base64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const JWT_HEADER = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const JWT_FOR_42 = `${JWT_HEADER}.${base64Url(JSON.stringify({ sub: 42 }))}.sig`;

function makeCookies(jwt: string | null): typeof chrome.cookies {
  return {
    get: vi.fn(async () => (jwt === null ? null : ({ value: jwt } as chrome.cookies.Cookie))),
  } as unknown as typeof chrome.cookies;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ankiOk(result: unknown): Response {
  return jsonResponse({ result, error: null });
}

const TOOL_NAME = 'record_enrichments';

function llmToolResponse(enrichments: unknown[]): Response {
  return jsonResponse({
    id: 'msg_test',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'tu_test',
        name: TOOL_NAME,
        input: { enrichments },
      },
    ],
  });
}

interface RouteOptions {
  profile?: unknown;
  lexemes?: Lexeme[];
  llmEnrichments?: unknown[];
  anki?: {
    deckNames?: string[];
    modelNames?: string[];
    addNotesResult?: (number | null)[];
    findNotesResult?: number[];
    version?: number;
    failOn?: string;
  };
  onAnthropic?: (init: RequestInit) => Response | Promise<Response>;
  onAnki?: (action: string, params: Record<string, unknown>) => Response | Promise<Response>;
}

interface RoutedFetch {
  fetchImpl: typeof fetch;
  callsByHost: Record<string, number>;
  ankiActions: string[];
}

function routedFetch(opts: RouteOptions): RoutedFetch {
  const callsByHost: Record<string, number> = {};
  const ankiActions: string[] = [];

  const lexemes = opts.lexemes ?? [];
  const profile = opts.profile ?? {
    currentCourse: { learningLanguage: 'el', fromLanguage: 'en' },
  };
  const ankiOpts = opts.anki ?? {};
  const version = ankiOpts.version ?? 6;
  const deckNames = ankiOpts.deckNames ?? [];
  const modelNames = ankiOpts.modelNames ?? [];
  const addNotesResult = ankiOpts.addNotesResult ?? lexemes.map((_, i) => i + 1);
  const findNotesResult = ankiOpts.findNotesResult ?? [];

  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlString = typeof input === 'string' ? input : input.toString();
      const url = new URL(urlString);
      callsByHost[url.host] = (callsByHost[url.host] ?? 0) + 1;

      if (url.host === 'www.duolingo.com') {
        if (url.pathname.includes('/learned-lexemes')) {
          const page: LexemesPage = {
            learnedLexemes: lexemes,
            pagination: {
              totalLexemes: lexemes.length,
              requestedPageSize: 50,
              pageSize: lexemes.length,
              previousStartIndex: null,
              nextStartIndex: null,
            },
          };
          return jsonResponse(page);
        }
        return jsonResponse(profile);
      }

      if (url.host === 'api.anthropic.com') {
        if (opts.onAnthropic) return await opts.onAnthropic(init ?? {});
        return llmToolResponse(opts.llmEnrichments ?? []);
      }

      if (url.host === '127.0.0.1:8765') {
        const body = JSON.parse((init?.body as string) ?? '{}') as {
          action: string;
          params: Record<string, unknown>;
        };
        ankiActions.push(body.action);
        if (opts.onAnki) return await opts.onAnki(body.action, body.params);
        if (ankiOpts.failOn === body.action) {
          throw new Error(`mock: action "${body.action}" forced failure`);
        }
        switch (body.action) {
          case 'version':
            return ankiOk(version);
          case 'deckNames':
            return ankiOk(deckNames);
          case 'createDeck':
            return ankiOk(null);
          case 'modelNames':
            return ankiOk(modelNames);
          case 'modelFieldNames':
            return ankiOk([
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
          case 'createModel':
            return ankiOk(null);
          case 'storeMediaFile':
            return ankiOk(null);
          case 'addNotes':
            return ankiOk(addNotesResult);
          case 'findNotes':
            return ankiOk(findNotesResult);
        }
        return ankiOk(null);
      }

      // Default catch-all (e.g. audio fetches).
      return new Response(new Uint8Array([0]), { status: 200 });
    },
  ) as unknown as typeof fetch;

  return { fetchImpl, callsByHost, ankiActions };
}

function lex(text: string, translations: string[] = []): Lexeme {
  return { text, translations, audioURL: null, isNew: false };
}

describe('runFullSync — happy path', () => {
  it('runs all 5 steps in order and returns aggregate result', async () => {
    const lexemes: Lexeme[] = [
      // High-confidence pass-through (no LLM call).
      lex('γεύμα', ['meal']),
      // Medium-confidence -ω verb (LLM-bound).
      lex('γράφω', ['I write']),
      // High-confidence phrase (pass-through).
      lex('με συγχωρείτε', ['excuse me']),
    ];
    const { fetchImpl, callsByHost, ankiActions } = routedFetch({
      lexemes,
      llmEnrichments: [
        {
          text: 'γράφω',
          pos: 'verb',
          gender: null,
          number: null,
          article: null,
          lemma: 'γράφω',
          inflection: '1sg present',
          notes: null,
        },
      ],
    });

    const events: SyncProgress[] = [];
    const result = await runFullSync({
      apiKey: 'sk-ant-test',
      deckName: 'Duolingo::Greek',
      skipAudio: true,
      language: 'el',
      cookies: makeCookies(JWT_FOR_42),
      storage: memoryStorage(),
      fetchImpl,
      onProgress: (p) => events.push(p),
    });

    // 5 distinct steps fired in order.
    const distinctSteps: SyncStep[] = [];
    for (const e of events) {
      if (distinctSteps[distinctSteps.length - 1] !== e.step) {
        distinctSteps.push(e.step);
      }
    }
    expect(distinctSteps).toEqual(['auth', 'profile', 'fetch-lexemes', 'enrich', 'sync-anki']);

    expect(result.course).toEqual({
      userId: '42',
      fromLanguage: 'en',
      learningLanguage: 'el',
    });
    expect(result.lexemeCount).toBe(3);
    expect(result.enrichmentCount).toBe(3);
    expect(result.anki.added).toBe(3);

    // Duolingo (profile + learned-lexemes) → 2, Anthropic → 1, Anki → many.
    expect(callsByHost['www.duolingo.com']).toBe(2);
    expect(callsByHost['api.anthropic.com']).toBe(1);
    expect(ankiActions).toContain('version');
    expect(ankiActions).toContain('addNotes');
  });

  it('emits at least one progress event per step (>= 5)', async () => {
    const { fetchImpl } = routedFetch({ lexemes: [lex('γεύμα', ['meal'])] });
    const events: SyncProgress[] = [];
    await runFullSync({
      apiKey: 'sk-ant-test',
      deckName: 'Duolingo::Greek',
      skipAudio: true,
      language: 'el',
      cookies: makeCookies(JWT_FOR_42),
      storage: memoryStorage(),
      fetchImpl,
      onProgress: (p) => events.push(p),
    });
    expect(events.length).toBeGreaterThanOrEqual(5);
    const stepsSeen = new Set(events.map((e) => e.step));
    expect(stepsSeen.size).toBe(5);
  });
});

describe('runFullSync — auth errors', () => {
  it('throws "Log in to Duolingo" when no JWT cookie is present', async () => {
    const { fetchImpl } = routedFetch({});
    await expect(
      runFullSync({
        apiKey: 'sk-ant-test',
        deckName: 'Duolingo::Greek',
        skipAudio: true,
        language: 'el',
        cookies: makeCookies(null),
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/Log in to Duolingo/i);
  });
});

describe('runFullSync — wrong course', () => {
  it('throws with both the actual and configured language codes', async () => {
    const { fetchImpl } = routedFetch({
      profile: {
        currentCourse: { learningLanguage: 'fr', fromLanguage: 'en' },
      },
    });
    await expect(
      runFullSync({
        apiKey: 'sk-ant-test',
        deckName: 'Duolingo::Greek',
        skipAudio: true,
        language: 'el',
        cookies: makeCookies(JWT_FOR_42),
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/fr.*not.*el/);
  });
});

describe('runFullSync — Anthropic error', () => {
  it('propagates a 401 from api.anthropic.com', async () => {
    const { fetchImpl } = routedFetch({
      lexemes: [lex('γράφω', ['I write'])],
      onAnthropic: () => new Response('invalid api key', { status: 401 }),
    });
    await expect(
      runFullSync({
        apiKey: 'sk-ant-bad',
        deckName: 'Duolingo::Greek',
        skipAudio: true,
        language: 'el',
        cookies: makeCookies(JWT_FOR_42),
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/401/);
  });
});

describe('runFullSync — AnkiConnect down', () => {
  it('propagates the "is Anki running" guidance when version action fails', async () => {
    const { fetchImpl } = routedFetch({
      lexemes: [lex('γεύμα', ['meal'])],
      anki: { failOn: 'version' },
    });
    await expect(
      runFullSync({
        apiKey: 'sk-ant-test',
        deckName: 'Duolingo::Greek',
        skipAudio: true,
        language: 'el',
        cookies: makeCookies(JWT_FOR_42),
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/is Anki running/);
  });
});
