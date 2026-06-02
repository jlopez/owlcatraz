import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  decodeUserIdFromJwt,
  extractProgressedSkills,
  fetchAllLearnedLexemes,
  fetchLearnedLexemes,
  fetchUserProfile,
  readJwtCookie,
  type CourseInfo,
  type ProgressedSkill,
} from '../src/lib/duolingo';
import type { LexemesPage } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../fixtures');

function loadJSON(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

// Synthetic JWT — payload decodes to {exp: 630720000, iat: 0, sub: 1000000}.
// The signature segment is not validated by the parser; "synth-signature-not-validated"
// is a clear marker that this is fixture data, not a real Duolingo session token.
const FIXTURE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjYzMDcyMDAwMCwiaWF0IjowLCJzdWIiOjEwMDAwMDB9.synth-signature-not-validated';

const COURSE: CourseInfo = {
  userId: '1000000',
  fromLanguage: 'en',
  learningLanguage: 'el',
};

const EXPECTED_SKILL_IDS = [
  'synth-skill-01',
  'synth-skill-02',
  'synth-skill-03',
  'synth-skill-04',
  'synth-skill-05',
  'synth-skill-06',
  'synth-skill-07',
  'synth-skill-08',
  'synth-skill-09',
  'synth-skill-10',
  'synth-skill-11',
  'synth-skill-12',
  'synth-skill-13',
];

describe('decodeUserIdFromJwt', () => {
  it('decodes the synthetic fixture JWT to "1000000"', () => {
    expect(decodeUserIdFromJwt(FIXTURE_JWT)).toBe('1000000');
  });

  it('round-trips a synthetic payload (string sub)', () => {
    const jwt = makeJwt({ sub: 'abc-123' });
    expect(decodeUserIdFromJwt(jwt)).toBe('abc-123');
  });

  it('round-trips a synthetic payload (numeric sub gets stringified)', () => {
    const jwt = makeJwt({ sub: 42 });
    expect(decodeUserIdFromJwt(jwt)).toBe('42');
  });

  it('throws on a one-segment string', () => {
    expect(() => decodeUserIdFromJwt('notajwt')).toThrow(/3 segments/);
  });

  it('throws on a two-segment string', () => {
    expect(() => decodeUserIdFromJwt('header.payload')).toThrow(/3 segments/);
  });

  it('throws when the payload decodes but is not JSON', () => {
    const garbage = base64UrlEncode('not json');
    expect(() => decodeUserIdFromJwt(`header.${garbage}.sig`)).toThrow(/JSON/);
  });

  it('throws when the payload is not valid base64url', () => {
    expect(() => decodeUserIdFromJwt('header.@@@@.sig')).toThrow(/base64url/);
  });

  it('decodes UTF-8 payloads correctly (not Latin-1)', () => {
    // "héllo" is 6 UTF-8 bytes; atob would yield a 6-char Latin-1 string,
    // mangling é. TextDecoder must be used to interpret the bytes as UTF-8.
    const jwt = makeJwt({ sub: 'héllo' });
    expect(decodeUserIdFromJwt(jwt)).toBe('héllo');
  });

  it('throws when the payload has no `sub` claim', () => {
    const jwt = makeJwt({ exp: 0 });
    expect(() => decodeUserIdFromJwt(jwt)).toThrow(/sub/);
  });

  it('throws when `sub` is the wrong type', () => {
    const jwt = makeJwt({ sub: { nested: 'object' } });
    expect(() => decodeUserIdFromJwt(jwt)).toThrow(/sub/);
  });
});

describe('extractProgressedSkills', () => {
  const profile = loadJSON('profile.json');
  const skills = extractProgressedSkills(profile);

  it('returns an array of length 13', () => {
    expect(skills).toHaveLength(13);
  });

  it('every entry has finishedLevels=99, finishedSessions=99 and a non-empty id', () => {
    for (const s of skills) {
      expect(s.finishedLevels).toBe(99);
      expect(s.finishedSessions).toBe(99);
      expect(typeof s.skillId.id).toBe('string');
      expect(s.skillId.id.length).toBeGreaterThan(0);
    }
  });

  it('sorted IDs match the captured set', () => {
    const ids = skills.map((s) => s.skillId.id).sort();
    expect(ids).toEqual(EXPECTED_SKILL_IDS);
  });

  it('returns [] for non-objects, missing currentCourse, or missing skills', () => {
    expect(extractProgressedSkills(null)).toEqual([]);
    expect(extractProgressedSkills(42)).toEqual([]);
    expect(extractProgressedSkills({})).toEqual([]);
    expect(extractProgressedSkills({ currentCourse: {} })).toEqual([]);
    expect(extractProgressedSkills({ currentCourse: { skills: 'nope' } })).toEqual([]);
  });
});

describe('readJwtCookie', () => {
  function makeCookiesMock(
    impl: (details: chrome.cookies.CookieDetails) => Promise<chrome.cookies.Cookie | null>,
  ): typeof chrome.cookies {
    return { get: vi.fn(impl) } as unknown as typeof chrome.cookies;
  }

  it('returns the cookie value when present', async () => {
    const cookies = makeCookiesMock(async () => ({ value: 'test-jwt' }) as chrome.cookies.Cookie);
    await expect(readJwtCookie(cookies)).resolves.toBe('test-jwt');
  });

  it('returns null when the cookie is absent', async () => {
    const cookies = makeCookiesMock(async () => null);
    await expect(readJwtCookie(cookies)).resolves.toBeNull();
  });

  it('returns null when the cookie exists but has an empty value', async () => {
    const cookies = makeCookiesMock(async () => ({ value: '' }) as chrome.cookies.Cookie);
    await expect(readJwtCookie(cookies)).resolves.toBeNull();
  });

  it('propagates errors from chrome.cookies.get', async () => {
    const cookies = makeCookiesMock(async () => {
      throw new Error('cookies permission denied');
    });
    await expect(readJwtCookie(cookies)).rejects.toThrow(/permission denied/);
  });

  it('queries duolingo.com for the jwt_token cookie', async () => {
    const get = vi.fn(async () => ({ value: 'x' }) as chrome.cookies.Cookie);
    const cookies = { get } as unknown as typeof chrome.cookies;
    await readJwtCookie(cookies);
    expect(get).toHaveBeenCalledWith({
      url: 'https://www.duolingo.com',
      name: 'jwt_token',
    });
  });
});

describe('fetchUserProfile', () => {
  it('fetches the profile and parses JSON', async () => {
    const profile = loadJSON('profile.json');
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(profile), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await fetchUserProfile({
      jwt: 'tok',
      userId: '1000000',
      fetchImpl,
    });
    expect(
      (result as { currentCourse: { learningLanguage: string } }).currentCourse.learningLanguage,
    ).toBe('el');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const url = new URL(calledUrl);
    expect(url.origin).toBe('https://www.duolingo.com');
    expect(url.pathname).toBe('/2023-05-23/users/1000000');
    expect(url.searchParams.get('fields')).toBe('currentCourse');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.method).toBe('GET');
  });

  it('throws on non-2xx with the status and body excerpt', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('upstream exploded', { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(fetchUserProfile({ jwt: 'tok', userId: 'u', fetchImpl })).rejects.toThrow(
      /502.*upstream exploded/,
    );
  });
});

describe('fetchLearnedLexemes', () => {
  const PAGE_NAMES: Record<number, string> = {
    0: 'page-0.json',
    50: 'page-50.json',
  };

  const PROGRESSED: ProgressedSkill[] = [
    { finishedLevels: 99, finishedSessions: 99, skillId: { id: 'skill-a' } },
  ];

  function fixtureFetch(): { fetchImpl: typeof fetch; calls: Array<[string, RequestInit]> } {
    const calls: Array<[string, RequestInit]> = [];
    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push([url, init ?? {}]);
      const startIndex = Number(new URL(url).searchParams.get('startIndex'));
      const name = PAGE_NAMES[startIndex];
      if (!name) {
        return new Response(`no fixture for startIndex=${String(startIndex)}`, { status: 404 });
      }
      return new Response(readFileSync(resolve(fixturesDir, name), 'utf8'), { status: 200 });
    });
    return { fetchImpl: impl as unknown as typeof fetch, calls };
  }

  it('paginates through both pages and collects all 50 lexemes', async () => {
    const { fetchImpl, calls } = fixtureFetch();
    const all = await fetchAllLearnedLexemes(COURSE, 'tok', PROGRESSED, { fetchImpl });
    expect(all).toHaveLength(50);
    expect(calls).toHaveLength(2);
  });

  it('builds the correct URL, headers, and body on every request', async () => {
    const { fetchImpl, calls } = fixtureFetch();
    await fetchAllLearnedLexemes(COURSE, 'tok', PROGRESSED, { fetchImpl });

    const expectedStarts = [0, 50];
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      expect(call).toBeDefined();
      const [calledUrl, init] = call as [string, RequestInit];
      const url = new URL(calledUrl);
      expect(url.origin).toBe('https://www.duolingo.com');
      expect(url.pathname).toBe('/2017-06-30/users/1000000/courses/el/en/learned-lexemes');
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('sortBy')).toBe('LEARNED_DATE');
      expect(url.searchParams.get('startIndex')).toBe(String(expectedStarts[i]));

      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as {
        lastTotalLexemeCount: number;
        progressedSkills: ProgressedSkill[];
      };
      expect(body.lastTotalLexemeCount).toBe(0);
      expect(Array.isArray(body.progressedSkills)).toBe(true);
      expect(body.progressedSkills.length).toBeGreaterThan(0);
    }
  });

  it('honors a non-default sortBy option', async () => {
    const { fetchImpl, calls } = fixtureFetch();
    await fetchAllLearnedLexemes(COURSE, 'tok', PROGRESSED, {
      fetchImpl,
      sortBy: 'ALPHABETICAL',
    });
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const [firstUrl] = firstCall as [string, RequestInit];
    expect(new URL(firstUrl).searchParams.get('sortBy')).toBe('ALPHABETICAL');
  });

  it('throws when the server responds with HTTP 500', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchAllLearnedLexemes(COURSE, 'tok', PROGRESSED, { fetchImpl })).rejects.toThrow(
      /500/,
    );
  });

  it('stops the loop when nextStartIndex is null (exactly 2 fetches for 50 lexemes)', async () => {
    const { fetchImpl, calls } = fixtureFetch();
    const all: unknown[] = [];
    for await (const lexeme of fetchLearnedLexemes(COURSE, 'tok', PROGRESSED, { fetchImpl })) {
      all.push(lexeme);
    }
    expect(all).toHaveLength(50);
    expect(calls).toHaveLength(2);
  });

  it('throws after the 100-iteration safety cap when nextStartIndex never goes null', async () => {
    let cursor = 0;
    const fetchImpl = vi.fn(async () => {
      cursor += 50;
      const page: LexemesPage = {
        learnedLexemes: [{ text: 'γ', translations: ['g'], audioURL: null, isNew: false }],
        pagination: {
          totalLexemes: 99999,
          requestedPageSize: 50,
          pageSize: 1,
          previousStartIndex: cursor - 50,
          nextStartIndex: cursor,
        },
      };
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchAllLearnedLexemes(COURSE, 'tok', PROGRESSED, { fetchImpl })).rejects.toThrow(
      /100 iterations/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(100);
  });

  it('throws if the response shape does not match LexemesPage', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchAllLearnedLexemes(COURSE, 'tok', PROGRESSED, { fetchImpl })).rejects.toThrow(
      /LexemesPage/,
    );
  });

  describe('French course (multi-language path)', () => {
    // Regression guard for PR 2: the learned-lexemes path is built from the
    // course's learningLanguage, so a French course must hit /courses/fr/en/…
    // rather than the Greek /courses/el/en/…. The fr fixture is a single page
    // (nextStartIndex null) so one fetch returns all 50 lexemes.
    const FR_COURSE: CourseInfo = {
      userId: '1000000',
      fromLanguage: 'en',
      learningLanguage: 'fr',
    };

    function frFetch(): { fetchImpl: typeof fetch; calls: Array<[string, RequestInit]> } {
      const calls: Array<[string, RequestInit]> = [];
      const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push([url, init ?? {}]);
        return new Response(readFileSync(resolve(fixturesDir, 'fr', 'page-0.json'), 'utf8'), {
          status: 200,
        });
      });
      return { fetchImpl: impl as unknown as typeof fetch, calls };
    }

    it('builds the fr course path and collects all 50 lexemes in a single fetch', async () => {
      const { fetchImpl, calls } = frFetch();
      const all = await fetchAllLearnedLexemes(FR_COURSE, 'tok', PROGRESSED, { fetchImpl });
      expect(all).toHaveLength(50);
      expect(calls).toHaveLength(1);
      const firstCall = calls[0];
      expect(firstCall).toBeDefined();
      const [calledUrl] = firstCall as [string, RequestInit];
      const url = new URL(calledUrl);
      expect(url.pathname).toBe('/2017-06-30/users/1000000/courses/fr/en/learned-lexemes');
    });
  });
});
