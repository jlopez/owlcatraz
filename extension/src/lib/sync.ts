import {
  decodeUserIdFromJwt,
  extractProgressedSkills,
  fetchLearnedLexemes,
  fetchUserProfile,
  readJwtCookie,
  type CourseInfo,
} from './duolingo';
import { enrichLexemes, type EnrichmentInput, type Storage } from './enrich';
import { getLanguageModule } from './lang/registry';
import { syncToAnki, type NoteData, type SyncResult } from './anki';
import type { Lexeme } from '../types';

export interface CurrentCourse {
  learningLanguage: string;
  fromLanguage: string;
}

export function extractCurrentCourse(profile: unknown): CurrentCourse | null {
  if (typeof profile !== 'object' || profile === null) return null;
  const cc = (profile as Record<string, unknown>)['currentCourse'];
  if (typeof cc !== 'object' || cc === null) return null;
  const rec = cc as Record<string, unknown>;
  const learning = rec['learningLanguage'];
  const from = rec['fromLanguage'];
  if (typeof learning !== 'string' || typeof from !== 'string') return null;
  return { learningLanguage: learning, fromLanguage: from };
}

export type SyncStep = 'auth' | 'profile' | 'fetch-lexemes' | 'enrich' | 'sync-anki';

export interface SyncProgress {
  step: SyncStep;
  current?: number;
  total?: number;
  message: string;
}

export interface SyncConfig {
  apiKey: string;
  deckName: string;
  skipAudio: boolean;
  // Duolingo course code (e.g. 'el', 'fr'). runFullSync resolves this to a
  // LanguageModule via the registry and refuses if the user's active course
  // does not match — the popup is the gatekeeper for what's supported.
  language: string;

  cookies: typeof chrome.cookies;
  storage: Storage;
  fetchImpl: typeof fetch;
  ankiFetchImpl?: typeof fetch;
  audioFetchImpl?: typeof fetch;
  onProgress?: (p: SyncProgress) => void;
}

export interface FullSyncResult {
  course: CourseInfo;
  lexemeCount: number;
  enrichmentCount: number;
  anki: SyncResult;
}

function emit(config: SyncConfig, progress: SyncProgress): void {
  if (config.onProgress) config.onProgress(progress);
}

export async function runFullSync(config: SyncConfig): Promise<FullSyncResult> {
  // Resolve the language module up front so an unsupported `config.language`
  // (e.g. service worker bug, stale popup state) fails fast with a clear
  // error before we touch the network.
  const languageModule = getLanguageModule(config.language);

  emit(config, { step: 'auth', message: 'Reading Duolingo session…' });
  const jwt = await readJwtCookie(config.cookies);
  if (jwt === null) {
    throw new Error('Not logged in. Log in to Duolingo at duolingo.com first, then try again.');
  }

  emit(config, { step: 'profile', message: 'Looking up your Duolingo profile…' });
  const userId = decodeUserIdFromJwt(jwt);
  const profile = await fetchUserProfile({
    jwt,
    userId,
    fetchImpl: config.fetchImpl,
  });
  const current = extractCurrentCourse(profile);
  if (current === null) {
    throw new Error('Could not read your active Duolingo course from the profile response.');
  }
  if (current.learningLanguage !== config.language) {
    throw new Error(
      `Your active Duolingo course is ${current.learningLanguage}, not ${config.language}. ` +
        `Switch courses on duolingo.com and try again.`,
    );
  }
  const progressedSkills = extractProgressedSkills(profile);
  const course: CourseInfo = {
    userId,
    fromLanguage: current.fromLanguage,
    learningLanguage: current.learningLanguage,
  };

  emit(config, {
    step: 'fetch-lexemes',
    current: 0,
    message: 'Fetching your learned words…',
  });
  const lexemes: Lexeme[] = [];
  for await (const lexeme of fetchLearnedLexemes(course, jwt, progressedSkills, {
    fetchImpl: config.fetchImpl,
  })) {
    lexemes.push(lexeme);
    if (lexemes.length % 50 === 0) {
      emit(config, {
        step: 'fetch-lexemes',
        current: lexemes.length,
        message: `Fetched ${String(lexemes.length)} words…`,
      });
    }
  }
  emit(config, {
    step: 'fetch-lexemes',
    current: lexemes.length,
    total: lexemes.length,
    message: `Fetched ${String(lexemes.length)} words total.`,
  });

  const inputs: EnrichmentInput[] = lexemes.map((lexeme) => ({
    lexeme,
    morphology: languageModule.inferMorphology(lexeme),
  }));

  emit(config, {
    step: 'enrich',
    total: inputs.length,
    message: `Enriching ${String(inputs.length)} words with grammatical metadata…`,
  });
  const enrichments = await enrichLexemes(inputs, {
    apiKey: config.apiKey,
    languageModule,
    storage: config.storage,
    fetchImpl: config.fetchImpl,
  });

  const notes: NoteData[] = lexemes.map((lexeme, i) => {
    const enrichment = enrichments[i];
    if (enrichment === undefined) {
      throw new Error(
        `runFullSync: missing enrichment for lexeme index ${String(i)} ("${lexeme.text}")`,
      );
    }
    return { lexeme, enrichment, language: course.learningLanguage };
  });

  emit(config, {
    step: 'sync-anki',
    total: notes.length,
    message: `Writing ${String(notes.length)} notes to Anki…`,
  });
  const ankiFetch = config.ankiFetchImpl ?? config.fetchImpl;
  const audioFetch = config.audioFetchImpl ?? config.fetchImpl;
  const ankiResult = await syncToAnki(notes, {
    deckName: config.deckName,
    fetchImpl: ankiFetch,
    audioFetchImpl: audioFetch,
    skipAudio: config.skipAudio,
  });

  return {
    course,
    lexemeCount: lexemes.length,
    enrichmentCount: enrichments.length,
    anki: ankiResult,
  };
}
