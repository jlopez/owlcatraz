import type { Lexeme } from '../types';
import type { Enrichment, EnrichmentGender, EnrichmentNumber } from './enrich';

const DEFAULT_ANKI_URL = 'http://127.0.0.1:8765';
const DEFAULT_MODEL_NAME = 'Duolingo Word';
const ANKI_CONNECT_VERSION = 6;
const NOTE_TAGS_BASE = 'duolingo';
const AUDIO_FILENAME_PREFIX = 'duolingo_';

// Bump on any change that alters note content or card templates: morphology
// rule edits, enrichment validation tightening, buildFields output, or
// CARD_TEMPLATES. Existing notes whose `owlcatraz:build:N` tag is below
// BUILD_VERSION get re-rendered through updateNoteFields on the next sync
// (and the template gets re-pushed via updateModelTemplates). This is how
// the deck self-heals without manual delete-and-resync.
//
// v2: rule-3 -οι/-ει/-αι exclusions; enrichment article-on-non-noun
// sanitization; Recognition card typing prompt = TargetWithArticle.
const BUILD_VERSION = 2;
const BUILD_TAG_PREFIX = 'owlcatraz:build:';
const BUILD_TAG_CURRENT = `${BUILD_TAG_PREFIX}${String(BUILD_VERSION)}`;

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
  updated: number;
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
    // Typing prompt is the article-prefixed form so the learner internalizes
    // the gender alongside the noun (standard pedagogy for grammatically
    // gendered languages). TargetWithArticle equals Target for non-nouns —
    // no article means the prompt is the bare surface form.
    Front: `<div class="english">{{English}}</div>
{{#Audio}}<div class="audio-hint">Listen first?</div>{{/Audio}}
<div class="type-prompt">{{type:TargetWithArticle}}</div>`,
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
    // Push current templates so existing decks pick up Recognition/Production
    // edits when BUILD_VERSION is bumped. updateModelTemplates re-renders
    // existing cards in place — review history is preserved. Idempotent at
    // the Anki layer if the templates are already current, but we avoid the
    // call when the stored templates already match to skip needless writes.
    const storedRaw = await ankiInvoke<unknown>('modelTemplates', { modelName }, options);
    const stored = storedRaw as Record<string, { Front?: string; Back?: string }> | null;
    let templatesMatch = stored !== null && typeof stored === 'object';
    if (templatesMatch && stored !== null) {
      for (const t of CARD_TEMPLATES) {
        const have = stored[t.Name];
        if (!have || have.Front !== t.Front || have.Back !== t.Back) {
          templatesMatch = false;
          break;
        }
      }
    }
    if (!templatesMatch) {
      const templates: Record<string, { Front: string; Back: string }> = {};
      for (const t of CARD_TEMPLATES) templates[t.Name] = { Front: t.Front, Back: t.Back };
      await ankiInvoke('updateModelTemplates', { model: { name: modelName, templates } }, options);
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

interface ExistingNote {
  noteId: number;
  fields: Record<string, string>;
  tags: string[];
}

// Query Anki for every note already in our deck under our model, returning
// the existing note metadata (id, fields, tags) keyed by LemmaKey. Lets
// syncToAnki:
//   1. skip notes whose build tag is current (no audio fetch, no addNotes);
//   2. update notes whose build tag is older (changed fields rebuilt in
//      place via updateNoteFields, preserving review history); and
//   3. compare candidate fields against existing ones to skip no-op writes
//      so AnkiWeb sync deltas only include actually-changed notes.
async function fetchExistingNotes(
  deckName: string,
  modelName: string,
  invokeOpts: InvokeOptions,
): Promise<Map<string, ExistingNote>> {
  const query = `deck:"${escapeAnkiQueryValue(deckName)}" note:"${escapeAnkiQueryValue(modelName)}"`;
  const ids = await ankiInvoke<unknown>('findNotes', { query }, invokeOpts);
  const out = new Map<string, ExistingNote>();
  if (!Array.isArray(ids) || ids.length === 0) return out;
  const info = await ankiInvoke<unknown>('notesInfo', { notes: ids }, invokeOpts);
  if (!Array.isArray(info)) return out;
  for (const note of info) {
    if (typeof note !== 'object' || note === null) continue;
    const n = note as Record<string, unknown>;
    const noteId = typeof n['noteId'] === 'number' ? n['noteId'] : null;
    const fieldsRaw = n['fields'];
    if (noteId === null || typeof fieldsRaw !== 'object' || fieldsRaw === null) continue;
    const fields: Record<string, string> = {};
    for (const [name, entry] of Object.entries(fieldsRaw as Record<string, unknown>)) {
      if (typeof entry === 'object' && entry !== null) {
        const value = (entry as Record<string, unknown>)['value'];
        if (typeof value === 'string') fields[name] = value;
      }
    }
    const lemmaKey = fields['LemmaKey'];
    if (typeof lemmaKey !== 'string' || lemmaKey === '') continue;
    const tagsRaw = n['tags'];
    const tags: string[] = Array.isArray(tagsRaw)
      ? tagsRaw.filter((t) => typeof t === 'string')
      : [];
    out.set(lemmaKey, { noteId, fields, tags });
  }
  return out;
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

function hasCurrentBuildTag(tags: readonly string[]): boolean {
  return tags.includes(BUILD_TAG_CURRENT);
}

// Matches only the auto-managed numeric build-version tags (owlcatraz:build:0,
// owlcatraz:build:1, …). Narrower than `startsWith(BUILD_TAG_PREFIX)` so a
// user who manually tags notes with anything else under the same prefix
// (owlcatraz:build:in-review, etc.) doesn't lose those tags on heal.
const STALE_BUILD_TAG_RE = /^owlcatraz:build:\d+$/;

// Build the next tag list for a note: keep everything that isn't an
// auto-managed build-version tag, then add BUILD_TAG_CURRENT. Strips stale
// `owlcatraz:build:N` numeric tags so a note doesn't accumulate one tag per
// build version over its lifetime.
function nextTags(prev: readonly string[], language: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of prev) {
    if (STALE_BUILD_TAG_RE.test(t)) continue;
    if (!seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  for (const required of [NOTE_TAGS_BASE, language, BUILD_TAG_CURRENT]) {
    if (!seen.has(required)) {
      out.push(required);
      seen.add(required);
    }
  }
  return out;
}

function fieldsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export async function syncToAnki(notes: NoteData[], options: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = {
    added: 0,
    skipped: 0,
    updated: 0,
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

  const existingByKey = await fetchExistingNotes(options.deckName, modelName, invokeOpts);

  // Three-way split:
  // - currentSkip: existing note already at BUILD_TAG_CURRENT → nothing to do.
  // - toUpdate: existing note at older build → updateNoteFields (if fields
  //   differ) + replaceTags. Audio is re-fetched only when the existing
  //   Audio field is empty (e.g. v1 had audio-fetch failure that we want to
  //   retry under v2). Otherwise we keep the existing Audio value so the
  //   user's already-stored MP3 isn't dropped.
  // - toAdd: no existing note → audio fetch + addNotes.
  // Critical invariant: notes are NEVER deleted-and-recreated in the update
  // path. updateNoteFields mutates in place; cards keep their full review
  // scheduling/history.
  interface UpdateCandidate {
    lemmaKey: string;
    existing: ExistingNote;
    note: NoteData;
  }
  const toUpdate: UpdateCandidate[] = [];
  const toAddInputs: { lemmaKey: string; note: NoteData }[] = [];
  for (const note of notes) {
    const lemmaKey = computeLemmaKey(note);
    const existing = existingByKey.get(lemmaKey);
    if (existing) {
      if (hasCurrentBuildTag(existing.tags)) {
        result.skipped += 1;
        continue;
      }
      toUpdate.push({ lemmaKey, existing, note });
    } else {
      toAddInputs.push({ lemmaKey, note });
    }
  }

  for (const u of toUpdate) {
    // Reuse existing Audio if present — avoids re-downloading every MP3 just
    // because we bumped build version. If the existing Audio is empty (e.g.
    // a prior audio fetch failed), try again now.
    //
    // Known limitations (intentional trade-offs):
    // - If the existing [sound:duolingo_<hash>.mp3] reference points at a
    //   file the user has since deleted from Anki's media folder, the
    //   broken reference is preserved. Detecting this would require a
    //   getMediaFilesNames roundtrip per sync. Workaround: clear the Audio
    //   field on the affected note and re-sync.
    // - If Duolingo rotated the lexeme's audioURL (CDN churn, re-recording),
    //   the hash-derived filename no longer matches the current URL but the
    //   stale file plays correctly. Same-lemma re-recordings stay locked to
    //   the older version. Same workaround.
    const existingAudio = u.existing.fields['Audio'] ?? '';
    // Wrap the per-note update so a single AnkiConnect failure (rejected
    // field shape, deck rename mid-sync, network glitch) doesn't kill the
    // whole heal. Mirrors the per-null classification on the addNotes path
    // — surface each failure through result.failed and continue.
    try {
      const audioField =
        existingAudio !== ''
          ? existingAudio
          : await maybeStoreAudio(u.note, options, invokeOpts, result);
      const { fields } = buildFields(u.note, audioField);
      const nextTagList = nextTags(u.existing.tags, u.note.language);
      const fieldsChanged = !fieldsEqual(fields, u.existing.fields);
      if (fieldsChanged) {
        await ankiInvoke(
          'updateNoteFields',
          { note: { id: u.existing.noteId, fields } },
          invokeOpts,
        );
        result.updated += 1;
      } else {
        // No content change — still counts as a skip from the user's POV.
        result.skipped += 1;
      }
      // Tag swap is cheap and lets the next sync short-circuit. Issue even
      // when fields were unchanged so the build tag advances. If this throws
      // we still keep updated/skipped counts above accurate — the failure
      // gets recorded but the field update already landed (next sync will
      // retry only the tag swap via the same code path).
      await ankiInvoke(
        'updateNoteTags',
        { note: u.existing.noteId, tags: nextTagList },
        invokeOpts,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push({ lemmaKey: u.lemmaKey, reason: `update failed: ${reason}` });
    }
  }

  if (toAddInputs.length === 0) return result;

  const built: BuiltNote[] = [];
  for (const ta of toAddInputs) {
    const audioField = await maybeStoreAudio(ta.note, options, invokeOpts, result);
    const { fields } = buildFields(ta.note, audioField);
    built.push({ lemmaKey: ta.lemmaKey, fields, language: ta.note.language });
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
    tags: [NOTE_TAGS_BASE, b.language, BUILD_TAG_CURRENT],
  }));

  // AnkiConnect's addNotes diverges from the documented per-id-null result
  // when notes fail to insert: it rolls the entire batch back and surfaces a
  // top-level error `"['cannot create note because it is a duplicate', …]"`
  // with one entry per failed note. Less likely now that we preflight via
  // fetchExistingNotes, but a note could still be created in Anki between
  // our preflight and addNotes. When the count of duplicate messages
  // matches the batch size, treat the call as `[null, null, …]` and let the
  // findNotes-based per-note classifier below decide skipped vs. truly-failed.
  // Any other shape (partial failures, non-dup errors) rethrows so we don't
  // silently drop unknown failures.
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
  BUILD_VERSION,
  BUILD_TAG_CURRENT,
  BUILD_TAG_PREFIX,
};
