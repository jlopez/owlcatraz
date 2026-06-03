import type {
  Enrichment,
  EnrichmentGender,
  EnrichmentInput,
  EnrichmentNumber,
  EnrichmentPOS,
  LanguageModule,
} from './lang/types';

export type {
  Enrichment,
  EnrichmentGender,
  EnrichmentInput,
  EnrichmentNumber,
  EnrichmentPOS,
} from './lang/types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_BATCH_SIZE = 100;
const TOOL_NAME = 'record_enrichments';
// Haiku occasionally drops an entry from the tool-call array on large batches
// (the LLM literature calls this "omission on long-list outputs"; observed
// empirically with 100-item batches). Re-queuing missing items so they roll
// into a subsequent batch lets a single retry recover them; the cap exists
// only to bound total work if the LLM is genuinely refusing one input.
const MAX_ATTEMPTS_PER_ITEM = 3;
// Bump this prefix if the Enrichment shape changes OR if validation rules
// tighten enough that previously-cached entries would now be wrong. Old
// entries become invisible (rather than silently mis-typed) on the next run.
// v2: validateEnrichment now strips gender/number/article on non-nouns;
// v1 entries for adjectives leaked phantom articles (μάλλινος → "ο μάλλινος").
// v3: cache key now includes language code so identical surface forms across
// languages cache independently — old v2 entries are language-ambiguous and
// must be re-enriched once.
// v4: 'preposition' added to the pos taxonomy. Greek function words like στον/
// στην/σε/από previously aborted the batch (no such pos) or — once the LLM
// retried — landed as a fallback pos; re-enrich so they get the correct value.
const CACHE_PREFIX = 'enrich:v4:';
// A full batch of 100 enrichments easily exceeds 4096 (~50-180 output tokens
// each); 16k leaves comfortable headroom without burning quota on aborted
// generations. Haiku 4.5 supports up to 64k.
const MAX_TOKENS = 16384;

export interface Storage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface EnrichOptions {
  apiKey: string;
  // Per-language config: enrichment system prompt, few-shot, valid article
  // and gender sets, lemma/inflection guidance. Required so the driver
  // never falls back to a language-neutral prompt that would silently mix
  // languages.
  languageModule: LanguageModule;
  model?: string;
  batchSize?: number;
  storage: Storage;
  fetchImpl?: typeof fetch;
  // Optional per-batch progress. Called once before each LLM batch is issued
  // and once when the LLM phase finishes, with (enriched, total) where `total`
  // is the count of LLM-bound words (synthesized + already-cached words are
  // excluded — they cost no API call). Lets the caller surface "enriching
  // N/total" progress; never called when there's nothing to send to the LLM.
  onProgress?: (enriched: number, total: number) => void;
}

interface CacheEntry {
  enrichment: Enrichment;
  cachedAt: number;
}

// POS taxonomy and number marking are intentionally shared across languages
// rather than living on each LanguageModule — both Greek and French (and any
// other planned Indo-European course) draw from the same nine POS values and
// distinguish singular vs plural. Revisit if a future language genuinely needs
// a different POS set or no number marking.
const VALID_POS: ReadonlySet<string> = new Set<EnrichmentPOS>([
  'noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'article',
  'preposition',
  'phrase',
  'particle',
  'other',
]);
const VALID_NUMBER: ReadonlySet<string> = new Set<EnrichmentNumber>(['singular', 'plural']);

// JSON Schema for the tool input, parameterized on the active language's
// allowed articles and genders. Mirrors the Enrichment type — keep them in
// lockstep when adding fields.
function buildToolSchema(module: LanguageModule): object {
  const articleEnum: (string | null)[] = [...module.enrichment.validArticles, null];
  const genderEnum: (EnrichmentGender | null)[] = [...module.enrichment.validGenders, null];
  return {
    type: 'object',
    required: ['enrichments'],
    properties: {
      enrichments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'pos', 'lemma'],
          properties: {
            text: { type: 'string', description: 'exact text of the input lexeme' },
            pos: {
              type: 'string',
              enum: [
                'noun',
                'verb',
                'adjective',
                'adverb',
                'pronoun',
                'article',
                'preposition',
                'phrase',
                'particle',
                'other',
              ],
            },
            gender: { type: ['string', 'null'], enum: genderEnum },
            number: { type: ['string', 'null'], enum: ['singular', 'plural', null] },
            article: {
              type: ['string', 'null'],
              enum: articleEnum,
              description: module.enrichment.articleDescription,
            },
            lemma: {
              type: 'string',
              description: module.enrichment.lemmaDescription,
            },
            inflection: {
              type: ['string', 'null'],
              description: module.enrichment.inflectionDescription,
            },
            notes: {
              type: ['string', 'null'],
              description: 'anything else useful for an Anki card, max ~60 chars',
            },
          },
        },
      },
    },
  };
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(hashBuf);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Cache keys include the language code so identical surface forms in two
// languages (e.g. "non" — French "no" vs. Greek-ASCII transliteration) cache
// independently. Without this scoping, the second language to enrich would
// silently inherit the first's metadata.
async function cacheKey(language: string, text: string): Promise<string> {
  return `${CACHE_PREFIX}${language}:${await sha256Hex(text)}`;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['cachedAt'] !== 'number') return false;
  const e = v['enrichment'];
  if (typeof e !== 'object' || e === null) return false;
  return typeof (e as Record<string, unknown>)['text'] === 'string';
}

/** Synthesize an Enrichment from a high-confidence morphology result without
 *  calling the LLM. Returns null if the morphology result isn't eligible. */
function synthesizeFromMorphology(input: EnrichmentInput): Enrichment | null {
  const m = input.morphology;
  if (m.confidence !== 'high' || m.needsEnrichment) return null;
  // High-confidence morphology only ever yields pos ∈ {'phrase', 'noun'}.
  // Anything else here would be a bug in the language module — bail out and
  // let the LLM resolve rather than risk synthesizing nonsense.
  if (m.pos !== 'noun' && m.pos !== 'phrase') return null;
  // lemma = text only holds for singular/non-inflected inputs. Phase-3 rules
  // never emit plural high-confidence today, but if one is added later the
  // singular can't be derived without the LLM — bail out to be safe.
  if (m.number === 'plural') return null;
  return {
    text: m.text,
    pos: m.pos,
    gender: m.gender,
    number: m.number,
    article: m.article,
    lemma: m.text,
    inflection: null,
    notes: null,
  };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}

function validateEnrichment(
  item: unknown,
  inputTexts: ReadonlySet<string>,
  module: LanguageModule,
): Enrichment {
  if (typeof item !== 'object' || item === null) {
    throw new Error('enrichLexemes: enrichment entry is not an object');
  }
  const v = item as Record<string, unknown>;
  const textRaw = v['text'];
  if (typeof textRaw !== 'string') {
    throw new Error('enrichLexemes: enrichment missing required string field "text"');
  }
  const text = textRaw;
  if (!inputTexts.has(text)) {
    throw new Error(
      `enrichLexemes: enrichment text "${text}" does not match any input lexeme (LLM hallucination or mangled echo)`,
    );
  }
  const pos = v['pos'];
  if (typeof pos !== 'string' || !VALID_POS.has(pos)) {
    throw new Error(
      `enrichLexemes: enrichment for "${text}" has invalid or missing pos: ${JSON.stringify(pos)}`,
    );
  }
  const posTyped = pos as EnrichmentPOS;
  // Gender/number/article are noun-only attributes. Adjectives, verbs,
  // pronouns etc. don't carry an inherent article — when they surface in text
  // alongside one it belongs to the modified noun. We force-null these fields
  // for non-nouns below, so the enum checks are ALSO gated on isNoun: a word
  // that *is itself* a function word — the French definite article "les", a
  // pronoun, a determiner — legitimately echoes its own surface form into the
  // article/gender field, and validating a field we're about to discard would
  // abort the whole sync over a value that never reaches Anki or the cache.
  // (Haiku also does this for adjectives, e.g. `pos:"adjective", article:"ο"`
  // for μάλλινος.) For nouns the enums stay strict — a noun with a bogus
  // article is a real error worth surfacing.
  const isNoun = posTyped === 'noun';
  const lemma = v['lemma'];
  if (typeof lemma !== 'string') {
    throw new Error(
      `enrichLexemes: enrichment for "${text}" missing required string field "lemma"`,
    );
  }
  const genderRaw = v['gender'] ?? null;
  if (
    isNoun &&
    genderRaw !== null &&
    (typeof genderRaw !== 'string' ||
      !module.enrichment.validGenders.has(genderRaw as EnrichmentGender))
  ) {
    throw new Error(
      `enrichLexemes: enrichment for "${text}" has invalid gender: ${JSON.stringify(genderRaw)}`,
    );
  }
  const numberRaw = v['number'] ?? null;
  if (
    isNoun &&
    numberRaw !== null &&
    (typeof numberRaw !== 'string' || !VALID_NUMBER.has(numberRaw))
  ) {
    throw new Error(
      `enrichLexemes: enrichment for "${text}" has invalid number: ${JSON.stringify(numberRaw)}`,
    );
  }
  const articleRaw = v['article'] ?? null;
  if (
    isNoun &&
    articleRaw !== null &&
    (typeof articleRaw !== 'string' || !module.enrichment.validArticles.has(articleRaw))
  ) {
    throw new Error(
      `enrichLexemes: enrichment for "${text}" has invalid article: ${JSON.stringify(articleRaw)}`,
    );
  }
  const inflectionRaw = v['inflection'] ?? null;
  if (inflectionRaw !== null && typeof inflectionRaw !== 'string') {
    throw new Error(`enrichLexemes: enrichment for "${text}" has invalid inflection`);
  }
  const notesRaw = v['notes'] ?? null;
  if (notesRaw !== null && typeof notesRaw !== 'string') {
    throw new Error(`enrichLexemes: enrichment for "${text}" has invalid notes`);
  }
  return {
    text,
    pos: posTyped,
    gender: isNoun ? (genderRaw as EnrichmentGender | null) : null,
    number: isNoun ? (numberRaw as EnrichmentNumber | null) : null,
    // Cast mirrors gender/number: the enum check is gated on isNoun, so TS no
    // longer narrows articleRaw to string here — but in the isNoun branch it
    // has been validated against validArticles.
    article: isNoun ? (articleRaw as string | null) : null,
    lemma,
    inflection: inflectionRaw,
    notes: notesRaw,
  };
}

// Truncated JSON preview of an arbitrary value, for diagnostics in structural
// parse errors. When Haiku ignores the tool schema (e.g. wraps enrichments in
// an object, returns prose, or emits an empty input) the failure is opaque
// without seeing what actually came back — but the full response can be large,
// so cap the length. Local console only; never sent anywhere.
function previewJson(value: unknown, max = 800): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value); // JSON.stringify(undefined) === undefined
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}… [truncated, ${String(s.length)} chars total]` : s;
}

function parseEnrichmentsResponse(
  json: unknown,
  inputs: EnrichmentInput[],
  module: LanguageModule,
): Enrichment[] {
  if (typeof json !== 'object' || json === null) {
    throw new Error(`enrichLexemes: response is not an object — got ${previewJson(json)}`);
  }
  const obj = json as Record<string, unknown>;
  // Surface truncation as a clear error before attempting to parse a tool_use
  // block whose `input` JSON may be cut off mid-object — otherwise the user
  // sees a confusing "missing required field" failure.
  if (obj['stop_reason'] === 'max_tokens') {
    throw new Error(
      'enrichLexemes: response truncated (stop_reason=max_tokens). Raise MAX_TOKENS or reduce batchSize.',
    );
  }
  const content = obj['content'];
  if (!Array.isArray(content)) {
    throw new Error(`enrichLexemes: response.content is not an array — got ${previewJson(obj)}`);
  }
  let toolInput: unknown;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'tool_use' && b['name'] === TOOL_NAME) {
      toolInput = b['input'];
      break;
    }
  }
  if (toolInput === undefined) {
    // Include the block types so a text-only refusal ("I can't help with…") or
    // a wrong tool name is visible rather than just "no tool_use block".
    const blockTypes = content
      .map((b) =>
        typeof b === 'object' && b !== null ? (b as Record<string, unknown>)['type'] : typeof b,
      )
      .join(', ');
    throw new Error(
      `enrichLexemes: response contained no tool_use block for "${TOOL_NAME}" (blocks: [${String(blockTypes)}]) — ${previewJson(content)}`,
    );
  }
  if (typeof toolInput !== 'object' || toolInput === null) {
    throw new Error(
      `enrichLexemes: tool_use.input is not an object — got ${previewJson(toolInput)}`,
    );
  }
  const arr = (toolInput as Record<string, unknown>)['enrichments'];
  if (!Array.isArray(arr)) {
    throw new Error(
      `enrichLexemes: tool_use.input.enrichments is not an array — got ${previewJson(toolInput)}`,
    );
  }
  const inputTexts = new Set(inputs.map((i) => i.lexeme.text));
  return arr.map((item) => validateEnrichment(item, inputTexts, module));
}

async function callAnthropic(
  inputs: EnrichmentInput[],
  options: EnrichOptions,
): Promise<Enrichment[]> {
  const f = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const module = options.languageModule;

  const lexemesPayload = inputs.map((i) => ({
    text: i.lexeme.text,
    translations: i.lexeme.translations,
    morphology_hint: i.morphology,
  }));

  const userContent =
    'Examples (input followed by the tool input you would record):\n' +
    module.enrichment.fewShot
      .map(
        (ex, n) =>
          `Example ${String(n + 1)}:\n  Input: ${JSON.stringify(ex.input)}\n  Tool input: ${JSON.stringify(ex.output)}`,
      )
      .join('\n') +
    '\n\nLexemes to enrich (call record_enrichments once with one entry per lexeme):\n' +
    JSON.stringify(lexemesPayload);

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: module.enrichment.systemPrompt,
    tools: [
      {
        name: TOOL_NAME,
        description: module.enrichment.toolDescription,
        input_schema: buildToolSchema(module),
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: userContent }],
  };

  const response = await f(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': options.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await readErrorBody(response);
    throw new Error(`enrichLexemes API call failed: HTTP ${String(response.status)} — ${errBody}`);
  }

  const json: unknown = await response.json();
  return parseEnrichmentsResponse(json, inputs, module);
}

interface Pending {
  idx: number;
  key: string;
  input: EnrichmentInput;
}

export async function enrichLexemes(
  inputs: EnrichmentInput[],
  options: EnrichOptions,
): Promise<Enrichment[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (batchSize <= 0) {
    throw new Error(`enrichLexemes: batchSize must be > 0 (got ${String(batchSize)})`);
  }
  const langCode = options.languageModule.code;

  const passThrough = new Map<number, Enrichment>();
  const remainders: { idx: number; input: EnrichmentInput }[] = [];
  for (const [i, input] of inputs.entries()) {
    const synth = synthesizeFromMorphology(input);
    if (synth) passThrough.set(i, synth);
    else remainders.push({ idx: i, input });
  }

  // Single batched chrome.storage.local.get for every cache key we might need.
  const remainderKeys = await Promise.all(
    remainders.map((r) => cacheKey(langCode, r.input.lexeme.text)),
  );
  const stored = remainders.length === 0 ? {} : await options.storage.get(remainderKeys);

  const cached = new Map<number, Enrichment>();
  const pending: Pending[] = [];
  for (const [i, r] of remainders.entries()) {
    const key = remainderKeys[i];
    if (key === undefined) continue;
    const entry = stored[key];
    if (entry !== undefined && isCacheEntry(entry)) {
      cached.set(r.idx, entry.enrichment);
    } else {
      pending.push({ idx: r.idx, key, input: r.input });
    }
  }

  const fresh = new Map<number, Enrichment>();
  const attempts = new Map<number, number>();
  const queue: Pending[] = [...pending];
  // Total LLM-bound words for progress. `fresh.size` (unique successes) is the
  // monotonic numerator — re-queued items aren't double-counted because each
  // idx lands in `fresh` at most once. Synthesized/cached words are excluded
  // (they never reach the queue), so this counts only words that cost a call.
  const totalToEnrich = pending.length;
  while (queue.length > 0) {
    const batch = queue.splice(0, batchSize);
    // Emit before issuing the call so the log shows a heartbeat per batch
    // ("enriching … (200/1500)") rather than only on completion.
    options.onProgress?.(fresh.size, totalToEnrich);
    for (const p of batch) {
      attempts.set(p.idx, (attempts.get(p.idx) ?? 0) + 1);
    }
    const enrichments = await callAnthropic(
      batch.map((p) => p.input),
      options,
    );

    const byText = new Map<string, Enrichment>();
    for (const e of enrichments) byText.set(e.text, e);

    const writes: Record<string, CacheEntry> = {};
    const now = Date.now();
    for (const p of batch) {
      const e = byText.get(p.input.lexeme.text);
      if (e !== undefined) {
        fresh.set(p.idx, e);
        writes[p.key] = { enrichment: e, cachedAt: now };
      } else if ((attempts.get(p.idx) ?? 0) >= MAX_ATTEMPTS_PER_ITEM) {
        throw new Error(
          `enrichLexemes: LLM repeatedly omitted "${p.input.lexeme.text}" after ${String(MAX_ATTEMPTS_PER_ITEM)} attempts`,
        );
      } else {
        // Re-queue at the tail. The dropped item rejoins the next batch
        // naturally — no separate retry pass.
        queue.push(p);
      }
    }
    if (Object.keys(writes).length > 0) {
      await options.storage.set(writes);
    }
  }
  // Final tick so the numerator reaches total once the LLM phase is done.
  if (totalToEnrich > 0) options.onProgress?.(fresh.size, totalToEnrich);

  const out: Enrichment[] = [];
  for (const [i] of inputs.entries()) {
    const p = passThrough.get(i);
    if (p !== undefined) {
      out.push(p);
      continue;
    }
    const c = cached.get(i);
    if (c !== undefined) {
      out.push(c);
      continue;
    }
    const ff = fresh.get(i);
    if (ff !== undefined) {
      out.push(ff);
      continue;
    }
    throw new Error(`enrichLexemes: internal error — no result for input index ${String(i)}`);
  }
  return out;
}

/** In-memory Storage adapter for tests and offline use. */
export function memoryStorage(initial: Record<string, unknown> = {}): Storage {
  const data: Record<string, unknown> = { ...initial };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const v = data[k];
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async set(items) {
      for (const k of Object.keys(items)) {
        const v = items[k];
        if (v !== undefined) data[k] = v;
      }
    },
  };
}

/** chrome.storage.local-backed Storage adapter. Constructed lazily so tests
 *  that import this module don't need a `chrome` global. */
export function chromeStorageAdapter(area?: chrome.storage.StorageArea): Storage {
  const a = area ?? chrome.storage.local;
  return {
    async get(keys) {
      return (await a.get(keys)) as Record<string, unknown>;
    },
    async set(items) {
      await a.set(items);
    },
  };
}

// Exported for tests so they can construct cache keys without re-implementing
// the hashing scheme.
export const __test = { cacheKey, CACHE_PREFIX, TOOL_NAME };
