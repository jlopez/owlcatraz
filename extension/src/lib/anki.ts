import type { Lexeme } from '../types';
import type { Enrichment, EnrichmentGender, EnrichmentNumber } from './enrich';

const DEFAULT_ANKI_URL = 'http://127.0.0.1:8765';
const DEFAULT_MODEL_NAME = 'Duolingo Word';
const ANKI_CONNECT_VERSION = 6;
const NOTE_TAGS_BASE = 'duolingo';
const AUDIO_FILENAME_PREFIX = 'duolingo_';

export interface NoteData {
  lexeme: Lexeme;
  enrichment: Enrichment;
  language: string;
}

export interface SyncOptions {
  deckName: string;
  modelName?: string;
  ankiUrl?: string;
  fetchImpl?: typeof fetch;
  audioFetchImpl?: typeof fetch;
  skipAudio?: boolean;
}

export interface SyncResult {
  added: number;
  skipped: number;
  audioStored: number;
  audioFailed: number;
  failed: { lemmaKey: string; reason: string }[];
}

interface InvokeOptions {
  ankiUrl?: string;
  fetchImpl?: typeof fetch;
}

const NOTE_TYPE_FIELDS: readonly string[] = [
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
];

const NOTE_TYPE_CSS = `.card { font-family: sans-serif; font-size: 18px; text-align: center; }
.target-large { font-size: 28px; margin: 12px 0; }
.english { font-size: 22px; }
.meta { color: #666; font-size: 14px; font-style: italic; }
.notes { color: #444; font-size: 14px; margin-top: 8px; }
.audio-hint, .type-prompt { color: #999; font-size: 12px; margin-top: 8px; }`;

interface CardTemplate {
  Name: string;
  Front: string;
  Back: string;
}

const CARD_TEMPLATES: readonly CardTemplate[] = [
  {
    Name: 'Recognition',
    Front: `<div class="english">{{English}}</div>
{{#Audio}}<div class="audio-hint">Listen first?</div>{{/Audio}}
<div class="type-prompt">{{type:Target}}</div>`,
    Back: `{{FrontSide}}
<hr>
<div class="target-large">{{TargetWithArticle}}</div>
<div class="audio">{{Audio}}</div>
<div class="meta">{{Lemma}} · {{POS}}</div>
{{#Inflection}}<div class="meta">{{Inflection}}</div>{{/Inflection}}
{{#Notes}}<div class="notes">{{Notes}}</div>{{/Notes}}`,
  },
  {
    Name: 'Production',
    Front: `<div class="target-large">{{TargetWithArticle}}</div>
<div class="audio">{{Audio}}</div>`,
    Back: `{{FrontSide}}
<hr>
<div class="english">{{English}}</div>
<div class="meta">{{Lemma}} · {{POS}}</div>
{{#Inflection}}<div class="meta">{{Inflection}}</div>{{/Inflection}}
{{#Notes}}<div class="notes">{{Notes}}</div>{{/Notes}}`,
  },
];

const GENDER_ABBR: Record<EnrichmentGender, string> = {
  m: 'masc.',
  f: 'fem.',
  n: 'neut.',
};

const NUMBER_ABBR: Record<EnrichmentNumber, string> = {
  singular: 'sing.',
  plural: 'pl.',
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(hashBuf);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function uint8ToBase64(bytes: Uint8Array): string {
  // btoa needs a binary string; build one char-per-byte. Audio MP3s from
  // Duolingo are small (a few hundred KB at most), so the per-byte loop is fine.
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Escape a value for use inside Anki's `field:"…"` search syntax. Backslash and
// double-quote are the two metacharacters that can break out of a quoted value;
// everything else (including ':', '*', spaces, non-ASCII) is literal once
// quoted. See https://docs.ankiweb.net/searching.html.
function escapeAnkiQueryValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}

interface AnkiResponse {
  result: unknown;
  error: string | null;
}

// The generic <T> is an unchecked cast on the response payload — callers MUST
// validate the shape they expect (e.g. Array.isArray, typeof checks) before
// using the value. The cast exists only to make call sites readable.
export async function ankiInvoke<T = unknown>(
  action: string,
  params: object,
  options: InvokeOptions,
): Promise<T> {
  const url = options.ankiUrl ?? DEFAULT_ANKI_URL;
  const f = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
    });
  } catch (cause) {
    throw new Error(
      `AnkiConnect request to ${url} failed (action="${action}") — is Anki running with the AnkiConnect addon installed?`,
      { cause },
    );
  }
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(
      `AnkiConnect HTTP ${String(response.status)} on action "${action}" — is Anki running with AnkiConnect installed? Body: ${body}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    throw new Error(`AnkiConnect response for action "${action}" was not valid JSON`, {
      cause,
    });
  }
  if (typeof json !== 'object' || json === null) {
    throw new Error(`AnkiConnect response for action "${action}" was not an object`);
  }
  const r = json as Partial<AnkiResponse>;
  if (!('error' in r) || !('result' in r)) {
    throw new Error(`AnkiConnect response for action "${action}" missing result/error fields`);
  }
  if (r.error !== null && r.error !== undefined) {
    throw new Error(`AnkiConnect action "${action}" failed: ${r.error}`);
  }
  return r.result as T;
}

export async function ensureDeck(deckName: string, options: InvokeOptions): Promise<void> {
  const names = await ankiInvoke<string[]>('deckNames', {}, options);
  if (Array.isArray(names) && names.includes(deckName)) return;
  await ankiInvoke('createDeck', { deck: deckName }, options);
}

export async function ensureNoteType(modelName: string, options: InvokeOptions): Promise<void> {
  const names = await ankiInvoke<string[]>('modelNames', {}, options);
  if (Array.isArray(names) && names.includes(modelName)) {
    // Pre-existing model — verify its field shape matches the schema this
    // extension expects. A mismatched model silently breaks `addNotes` and
    // duplicate detection (Anki keys duplicates off the model's first field).
    const existing = await ankiInvoke<string[]>('modelFieldNames', { modelName }, options);
    const ok =
      Array.isArray(existing) &&
      existing.length === NOTE_TYPE_FIELDS.length &&
      existing.every((f, i) => f === NOTE_TYPE_FIELDS[i]);
    if (!ok) {
      throw new Error(
        `Anki note type "${modelName}" already exists but its fields do not match this extension's schema. ` +
          `Expected [${NOTE_TYPE_FIELDS.join(', ')}], got [${Array.isArray(existing) ? existing.join(', ') : String(existing)}]. ` +
          `Rename or delete the existing model in Anki, or pass a different modelName in extension settings.`,
      );
    }
    return;
  }
  await ankiInvoke(
    'createModel',
    {
      modelName,
      inOrderFields: NOTE_TYPE_FIELDS,
      css: NOTE_TYPE_CSS,
      isCloze: false,
      cardTemplates: CARD_TEMPLATES,
    },
    options,
  );
}

export function formatPOS(enrichment: Enrichment): string {
  switch (enrichment.pos) {
    case 'noun': {
      const parts: string[] = [];
      if (enrichment.gender !== null) parts.push(GENDER_ABBR[enrichment.gender]);
      if (enrichment.number !== null) parts.push(NUMBER_ABBR[enrichment.number]);
      return parts.length > 0 ? `noun (${parts.join(', ')})` : 'noun';
    }
    case 'verb':
    case 'adjective':
    case 'phrase':
    case 'pronoun':
    case 'particle':
    case 'adverb':
    case 'other':
      return enrichment.pos;
    default: {
      // Future-proof: if EnrichmentPOS gains a member, this fails both at
      // compile time (the never binding) and at runtime (clear message).
      const _exhaustive: never = enrichment.pos;
      throw new Error(`formatPOS: unexpected pos ${String(_exhaustive)}`);
    }
  }
}

// LemmaKey schema: `${lang}:${lemma}:${text}`. See buildFields for the
// rationale on including the surface form (per-inflection cards).
function computeLemmaKey(note: NoteData): string {
  return `${note.language}:${note.enrichment.lemma}:${note.lexeme.text}`;
}

function buildFields(
  note: NoteData,
  audioField: string,
): { lemmaKey: string; fields: Record<string, string> } {
  const { lexeme, enrichment, language } = note;
  // Include the surface form, not just the lemma, so each Duolingo lexeme gets
  // its own Anki card. Inflected forms (e.g. διαβάζω/διαβάζεις/διαβάζετε all
  // share lemma διαβάζω) would otherwise collide in Anki's first-field-based
  // duplicate detection — both within a single batch and across syncs.
  // Sorting by LemmaKey still groups inflections of the same lemma together.
  const lemmaKey = computeLemmaKey(note);
  const englishBase = lexeme.translations.join(' / ');
  // The Notes field already carries enrichment.notes verbatim; we also append
  // a hint to English so the Recognition front shows the polite/idiomatic
  // qualification next to the bare gloss without forcing the learner to flip.
  const english =
    enrichment.notes !== null && enrichment.notes !== ''
      ? `${englishBase} — ${enrichment.notes}`
      : englishBase;
  const targetWithArticle =
    enrichment.article !== null ? `${enrichment.article} ${lexeme.text}` : lexeme.text;
  const fields: Record<string, string> = {
    LemmaKey: lemmaKey,
    Language: language,
    English: english,
    Target: lexeme.text,
    TargetWithArticle: targetWithArticle,
    Lemma: enrichment.lemma,
    POS: formatPOS(enrichment),
    Inflection: enrichment.inflection ?? '',
    Notes: enrichment.notes ?? '',
    Audio: audioField,
  };
  return { lemmaKey, fields };
}

interface BuiltNote {
  lemmaKey: string;
  fields: Record<string, string>;
  language: string;
}

// Query Anki for every note already in our deck under our model, and return
// the set of their LemmaKey values. Lets syncToAnki skip already-synced
// lexemes entirely — without this, a re-sync downloads every audio file and
// uploads every note before discovering them as duplicates.
async function fetchExistingLemmaKeys(
  deckName: string,
  modelName: string,
  invokeOpts: InvokeOptions,
): Promise<Set<string>> {
  const query = `deck:"${escapeAnkiQueryValue(deckName)}" note:"${escapeAnkiQueryValue(modelName)}"`;
  const ids = await ankiInvoke<unknown>('findNotes', { query }, invokeOpts);
  if (!Array.isArray(ids) || ids.length === 0) return new Set();
  const info = await ankiInvoke<unknown>('notesInfo', { notes: ids }, invokeOpts);
  const keys = new Set<string>();
  if (!Array.isArray(info)) return keys;
  for (const note of info) {
    if (typeof note !== 'object' || note === null) continue;
    const fields = (note as Record<string, unknown>)['fields'];
    if (typeof fields !== 'object' || fields === null) continue;
    const lemmaField = (fields as Record<string, unknown>)['LemmaKey'];
    if (typeof lemmaField !== 'object' || lemmaField === null) continue;
    const value = (lemmaField as Record<string, unknown>)['value'];
    if (typeof value === 'string') keys.add(value);
  }
  return keys;
}

async function maybeStoreAudio(
  note: NoteData,
  options: SyncOptions,
  invokeOpts: InvokeOptions,
  result: SyncResult,
): Promise<string> {
  if (note.lexeme.audioURL === null || options.skipAudio === true) return '';
  const audioFetch = options.audioFetchImpl ?? options.fetchImpl ?? fetch;
  // Only swallow upstream audio-fetch / decode errors. If `storeMediaFile`
  // fails it means AnkiConnect itself is broken (Anki crashed, addon
  // disabled), and we want to bail fast instead of silently dropping audio
  // for every subsequent note before the eventual `addNotes` call fails.
  let bytes: Uint8Array;
  try {
    const res = await audioFetch(note.lexeme.audioURL);
    if (!res.ok) {
      throw new Error(`audio fetch HTTP ${String(res.status)}`);
    }
    const buf = await res.arrayBuffer();
    bytes = new Uint8Array(buf);
  } catch (err) {
    // The stats panel exposes the failure count, but without a console
    // breadcrumb the user has no way to diagnose 404 vs. CORS vs. CDN
    // rotation. One line per failing URL is enough.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`owlcatraz: audio fetch failed for ${note.lexeme.audioURL}: ${reason}`);
    result.audioFailed += 1;
    return '';
  }
  const hash = await sha256Hex(note.lexeme.audioURL);
  const filename = `${AUDIO_FILENAME_PREFIX}${hash}.mp3`;
  const data = uint8ToBase64(bytes);
  await ankiInvoke('storeMediaFile', { filename, data }, invokeOpts);
  result.audioStored += 1;
  return `[sound:${filename}]`;
}

export async function syncToAnki(notes: NoteData[], options: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = {
    added: 0,
    skipped: 0,
    audioStored: 0,
    audioFailed: 0,
    failed: [],
  };
  const ankiUrl = options.ankiUrl ?? DEFAULT_ANKI_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const modelName = options.modelName ?? DEFAULT_MODEL_NAME;
  const invokeOpts: InvokeOptions = { ankiUrl, fetchImpl };

  const version = await ankiInvoke<unknown>('version', {}, invokeOpts);
  if (typeof version !== 'number' || version < ANKI_CONNECT_VERSION) {
    throw new Error(
      `AnkiConnect returned version ${String(version)} but ${String(ANKI_CONNECT_VERSION)}+ is required. Install/update the AnkiConnect addon in Anki (https://foosoft.net/projects/anki-connect/).`,
    );
  }

  await ensureDeck(options.deckName, invokeOpts);
  await ensureNoteType(modelName, invokeOpts);

  if (notes.length === 0) return result;

  const existingKeys = await fetchExistingLemmaKeys(options.deckName, modelName, invokeOpts);

  const built: BuiltNote[] = [];
  for (const note of notes) {
    const lemmaKey = computeLemmaKey(note);
    if (existingKeys.has(lemmaKey)) {
      // Skip already-synced lexemes before paying for audio fetch + storeMedia.
      result.skipped += 1;
      continue;
    }
    const audioField = await maybeStoreAudio(note, options, invokeOpts, result);
    const { fields } = buildFields(note, audioField);
    built.push({ lemmaKey, fields, language: note.language });
  }

  if (built.length === 0) return result;

  const ankiNotes = built.map((b) => ({
    deckName: options.deckName,
    modelName,
    fields: b.fields,
    options: {
      allowDuplicate: false,
      duplicateScope: 'deck',
      duplicateScopeOptions: {
        deckName: options.deckName,
        checkChildren: false,
        checkAllModels: false,
      },
    },
    tags: [NOTE_TAGS_BASE, b.language],
  }));

  // AnkiConnect's addNotes diverges from the documented per-id-null result
  // when notes fail to insert: it rolls the entire batch back and surfaces a
  // top-level error `"['cannot create note because it is a duplicate', …]"`
  // with one entry per failed note. On the second sync every note is a
  // deck-level duplicate, so this is the hot path for re-runs. When the count
  // of duplicate messages matches the batch size, treat the call as `[null,
  // null, …]` and let the findNotes-based per-note classifier below decide
  // skipped vs. truly-failed. Any other shape (partial failures, non-dup
  // errors) rethrows so we don't silently drop unknown failures.
  let ids: (number | null)[];
  try {
    ids = await ankiInvoke<(number | null)[]>('addNotes', { notes: ankiNotes }, invokeOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const dupMatches = msg.match(/cannot create note because it is a duplicate/g);
    if (
      msg.includes('"addNotes"') &&
      dupMatches !== null &&
      dupMatches.length === ankiNotes.length
    ) {
      ids = new Array<number | null>(ankiNotes.length).fill(null);
    } else {
      throw err;
    }
  }
  if (!Array.isArray(ids) || ids.length !== built.length) {
    throw new Error(
      `AnkiConnect addNotes returned ${String(Array.isArray(ids) ? ids.length : 'non-array')} entries; expected ${String(built.length)}`,
    );
  }

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const b = built[i];
    if (b === undefined) continue;
    if (typeof id === 'number') {
      result.added += 1;
      continue;
    }
    // null — either a duplicate (allowDuplicate=false) or a real failure.
    // Anki field-search syntax is `field:"value"` — quotes around the VALUE,
    // not around the field:value pair. Wrapping the whole pair (as in older
    // drafts of this code) becomes a phrase search across all fields and
    // never matches a real note. See https://docs.ankiweb.net/searching.html.
    const query = `deck:"${escapeAnkiQueryValue(options.deckName)}" LemmaKey:"${escapeAnkiQueryValue(b.lemmaKey)}"`;
    const found = await ankiInvoke<number[]>('findNotes', { query }, invokeOpts);
    if (Array.isArray(found) && found.length >= 1) {
      result.skipped += 1;
    } else {
      result.failed.push({
        lemmaKey: b.lemmaKey,
        reason: 'addNotes returned null but no existing note found',
      });
    }
  }

  return result;
}

// Exported for tests so they can introspect the model creation payload without
// reaching into module internals.
export const __test = {
  NOTE_TYPE_FIELDS,
  NOTE_TYPE_CSS,
  CARD_TEMPLATES,
  DEFAULT_MODEL_NAME,
  DEFAULT_ANKI_URL,
};
