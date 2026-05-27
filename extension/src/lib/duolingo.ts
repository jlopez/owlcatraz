import { isLexemesPage, type Lexeme } from '../types';

export interface ProgressedSkill {
  finishedLevels: number;
  finishedSessions: number;
  skillId: { id: string };
}

export interface CourseInfo {
  userId: string;
  fromLanguage: string;
  learningLanguage: string;
}

export interface FetchLexemesOptions {
  pageSize?: number;
  sortBy?: 'LEARNED_DATE' | 'ALPHABETICAL';
  fetchImpl?: typeof fetch;
}

const DUOLINGO_ORIGIN = 'https://www.duolingo.com';
const MAX_PAGINATION_ITERATIONS = 100;

function base64UrlToBase64(s: string): string {
  const replaced = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (replaced.length % 4)) % 4;
  return replaced + '='.repeat(padLen);
}

export function decodeUserIdFromJwt(jwt: string): string {
  const segments = jwt.split('.');
  if (segments.length !== 3) {
    throw new Error(`Malformed JWT: expected 3 segments, got ${segments.length}`);
  }
  const payloadSegment = segments[1];
  if (!payloadSegment) {
    throw new Error('Malformed JWT: empty payload segment');
  }
  let json: string;
  try {
    const binary = atob(base64UrlToBase64(payloadSegment));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch (cause) {
    throw new Error(`Malformed JWT: payload is not valid base64url`, { cause });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (cause) {
    throw new Error('Malformed JWT: payload is not valid JSON', { cause });
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Malformed JWT: payload is not an object');
  }
  const sub = (payload as Record<string, unknown>)['sub'];
  if (sub === undefined || sub === null) {
    throw new Error('Malformed JWT: payload has no `sub` claim');
  }
  if (typeof sub !== 'string' && typeof sub !== 'number') {
    throw new Error(`Malformed JWT: \`sub\` claim has unexpected type ${typeof sub}`);
  }
  return String(sub);
}

export async function readJwtCookie(
  cookies: typeof chrome.cookies = chrome.cookies,
): Promise<string | null> {
  const cookie = await cookies.get({ url: DUOLINGO_ORIGIN, name: 'jwt_token' });
  if (!cookie || !cookie.value) return null;
  return cookie.value;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}

export async function fetchUserProfile(args: {
  jwt: string;
  userId: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const f = args.fetchImpl ?? fetch;
  const url = new URL(`/2023-05-23/users/${encodeURIComponent(args.userId)}`, DUOLINGO_ORIGIN);
  url.searchParams.set('fields', 'currentCourse');
  const response = await f(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.jwt}` },
  });
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`fetchUserProfile failed: HTTP ${response.status} — ${body}`);
  }
  return response.json();
}

export function extractProgressedSkills(profile: unknown): ProgressedSkill[] {
  if (typeof profile !== 'object' || profile === null) return [];
  const currentCourse = (profile as Record<string, unknown>)['currentCourse'];
  if (typeof currentCourse !== 'object' || currentCourse === null) return [];
  const skills = (currentCourse as Record<string, unknown>)['skills'];
  if (!Array.isArray(skills)) return [];

  const result: ProgressedSkill[] = [];
  for (const inner of skills) {
    if (!Array.isArray(inner)) continue;
    for (const skill of inner) {
      if (typeof skill !== 'object' || skill === null) continue;
      const s = skill as Record<string, unknown>;
      const id = s['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      const finishedLevels = typeof s['finishedLevels'] === 'number' ? s['finishedLevels'] : 0;
      const finishedLessons = typeof s['finishedLessons'] === 'number' ? s['finishedLessons'] : 0;
      if (finishedLevels <= 0 && finishedLessons <= 0) continue;
      // Empirically validated 2026-05-20: server ignores finishedLevels/finishedSessions
      // numeric values — only the skill IDs are load-bearing. 99/99 is a safe sentinel.
      result.push({ finishedLevels: 99, finishedSessions: 99, skillId: { id } });
    }
  }
  return result;
}

export async function* fetchLearnedLexemes(
  course: CourseInfo,
  jwt: string,
  progressedSkills: ProgressedSkill[],
  options: FetchLexemesOptions = {},
): AsyncGenerator<Lexeme, void, void> {
  const pageSize = options.pageSize ?? 50;
  const sortBy = options.sortBy ?? 'LEARNED_DATE';
  const f = options.fetchImpl ?? fetch;

  const path =
    `/2017-06-30/users/${encodeURIComponent(course.userId)}` +
    `/courses/${encodeURIComponent(course.learningLanguage)}/${encodeURIComponent(course.fromLanguage)}` +
    `/learned-lexemes`;

  const body = JSON.stringify({
    lastTotalLexemeCount: 0,
    progressedSkills,
  });

  let startIndex: number | null = 0;
  let iterations = 0;
  while (startIndex !== null) {
    if (iterations >= MAX_PAGINATION_ITERATIONS) {
      throw new Error(
        `fetchLearnedLexemes exceeded ${String(MAX_PAGINATION_ITERATIONS)} iterations — refusing to loop further`,
      );
    }
    iterations += 1;

    const url = new URL(path, DUOLINGO_ORIGIN);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('sortBy', sortBy);
    url.searchParams.set('startIndex', String(startIndex));

    const response = await f(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!response.ok) {
      const errBody = await readErrorBody(response);
      throw new Error(`fetchLearnedLexemes failed: HTTP ${response.status} — ${errBody}`);
    }
    const json: unknown = await response.json();
    if (!isLexemesPage(json)) {
      throw new Error('fetchLearnedLexemes: response did not match LexemesPage shape');
    }
    for (const lexeme of json.learnedLexemes) {
      yield lexeme;
    }
    startIndex = json.pagination.nextStartIndex;
  }
}

export async function fetchAllLearnedLexemes(
  course: CourseInfo,
  jwt: string,
  progressedSkills: ProgressedSkill[],
  options?: FetchLexemesOptions,
): Promise<Lexeme[]> {
  const all: Lexeme[] = [];
  for await (const lexeme of fetchLearnedLexemes(course, jwt, progressedSkills, options)) {
    all.push(lexeme);
  }
  return all;
}
