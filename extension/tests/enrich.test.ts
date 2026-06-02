import { describe, expect, it, vi } from 'vitest';
import {
  __test,
  chromeStorageAdapter,
  enrichLexemes,
  memoryStorage,
  type Enrichment,
  type EnrichmentInput,
  type Storage,
} from '../src/lib/enrich';
import type { MorphologyResult } from '../src/lib/lang/types';
import { el } from '../src/lib/lang/el';
import { fr } from '../src/lib/lang/fr';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function lex(text: string, translations: string[] = []): EnrichmentInput['lexeme'] {
  return { text, translations, audioURL: null, isNew: false };
}

function passthrough(text: string): EnrichmentInput {
  const morphology: MorphologyResult = {
    text,
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'high',
    reason: '-μα ending → neuter',
    needsEnrichment: false,
  };
  return { lexeme: lex(text), morphology };
}

function needsLlm(text: string, translations: string[] = []): EnrichmentInput {
  const morphology: MorphologyResult = {
    text,
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'medium',
    reason: '-ω ending → likely verb',
    needsEnrichment: true,
  };
  return { lexeme: lex(text, translations), morphology };
}

function makeEnrichment(partial: Partial<Enrichment> & { text: string }): Enrichment {
  return {
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    lemma: partial.text,
    inflection: null,
    notes: null,
    ...partial,
  };
}

function mockToolResponse(enrichments: unknown[]): Response {
  const body = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'tu_test',
        name: __test.TOOL_NAME,
        input: { enrichments },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('enrichLexemes — pass-through', () => {
  it('synthesizes enrichments from high-confidence morphology without calling fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const storage = memoryStorage();
    const result = await enrichLexemes([passthrough('γεύμα'), passthrough('όνομα')], {
      apiKey: 'sk-test',
      languageModule: el,
      storage,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      text: 'γεύμα',
      pos: 'noun',
      gender: 'n',
      number: 'singular',
      article: 'το',
      lemma: 'γεύμα',
      inflection: null,
      notes: null,
    });
    expect(result[1]?.text).toBe('όνομα');
  });

  it('does NOT synthesize for a high-confidence plural — falls through to LLM', async () => {
    // No current morphology rule emits plural at confidence='high', but if one
    // is added later the singular can't be derived without the LLM.
    const pluralHint: MorphologyResult = {
      text: 'γεύματα',
      pos: 'noun',
      gender: 'n',
      number: 'plural',
      article: 'τα',
      confidence: 'high',
      reason: '(hypothetical) -ματα plural of -μα',
      needsEnrichment: false,
    };
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        {
          text: 'γεύματα',
          pos: 'noun',
          gender: 'n',
          number: 'plural',
          article: 'τα',
          lemma: 'γεύμα',
          inflection: 'plural of γεύμα',
        },
      ]),
    ) as unknown as typeof fetch;
    const result = await enrichLexemes([{ lexeme: lex('γεύματα'), morphology: pluralHint }], {
      apiKey: 'sk',
      languageModule: el,
      storage: memoryStorage(),
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result[0]?.lemma).toBe('γεύμα');
  });
});

describe('enrichLexemes — cache hit', () => {
  it('returns the cached enrichment and never calls fetch', async () => {
    const text = 'διαβάζω';
    const key = await __test.cacheKey(el.code, text);
    const enrichment: Enrichment = makeEnrichment({
      text,
      pos: 'verb',
      lemma: 'διαβάζω',
      inflection: '1sg present',
    });
    const storage = memoryStorage({
      [key]: { enrichment, cachedAt: 1234567890 },
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await enrichLexemes([needsLlm(text, ['I read'])], {
      apiKey: 'sk-test',
      languageModule: el,
      storage,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual([enrichment]);
  });
});

describe('enrichLexemes — cache miss → API call', () => {
  it('issues exactly one fetch with the expected URL/headers/body and writes the cache', async () => {
    const text = 'διαβάζω';
    const enrichment = makeEnrichment({
      text,
      pos: 'verb',
      lemma: 'διαβάζω',
      inflection: '1sg present indicative',
    });
    const fetchImpl = vi.fn(async () => mockToolResponse([enrichment])) as unknown as typeof fetch;
    const storage = memoryStorage();

    const result = await enrichLexemes([needsLlm(text, ['I read'])], {
      apiKey: 'sk-test',
      languageModule: el,
      storage,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_URL);

    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');

    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      model: string;
      tools: { name: string; input_schema: unknown }[];
      tool_choice: { type: string; name: string };
      messages: { role: string; content: string }[];
      system: string;
    };
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.name).toBe('record_enrichments');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_enrichments' });
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.content).toContain(text);
    expect(body.system).toContain('Greek linguistics');

    expect(result).toEqual([enrichment]);

    // Cache populated.
    const key = await __test.cacheKey(el.code, text);
    const stored = await storage.get([key]);
    expect(stored[key]).toBeDefined();
    const entry = stored[key] as { enrichment: Enrichment; cachedAt: number };
    expect(entry.enrichment).toEqual(enrichment);
    expect(typeof entry.cachedAt).toBe('number');
  });

  it('honors a model override', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([makeEnrichment({ text: 'γράφω', pos: 'verb', lemma: 'γράφω' })]),
    ) as unknown as typeof fetch;
    await enrichLexemes([needsLlm('γράφω')], {
      apiKey: 'sk',
      languageModule: el,
      model: 'claude-sonnet-4-6',
      storage: memoryStorage(),
      fetchImpl,
    });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const init = (calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe('claude-sonnet-4-6');
  });
});

describe('enrichLexemes — batching', () => {
  it('splits 150 lexemes into two API calls (100 + 50) and writes both to cache', async () => {
    const inputs: EnrichmentInput[] = [];
    for (let i = 0; i < 150; i += 1) {
      inputs.push(needsLlm(`λέξη${String(i)}`));
    }

    let callIdx = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(((init?.body as string) ?? '') || '{}') as {
        messages: { content: string }[];
      };
      // Pull the embedded JSON payload of lexemes back out of the user message
      // and produce one enrichment per supplied text.
      const content = body.messages[0]?.content ?? '';
      const match = content.match(/Lexemes to enrich[^:]*:\n(\[.*\])$/s);
      const parsed = match ? (JSON.parse(match[1] ?? '[]') as { text: string }[]) : [];
      callIdx += 1;
      return mockToolResponse(
        parsed.map((l) => makeEnrichment({ text: l.text, pos: 'verb', lemma: l.text })),
      );
    }) as unknown as typeof fetch;

    const storage = memoryStorage();
    const result = await enrichLexemes(inputs, {
      apiKey: 'sk',
      languageModule: el,
      storage,
      fetchImpl,
    });

    expect(callIdx).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(150);

    // Verify per-call batch sizes by inspecting the request bodies.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const sizes = calls.map((c) => {
      const init = (c as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
      const content = body.messages[0]?.content ?? '';
      const m = content.match(/Lexemes to enrich[^:]*:\n(\[.*\])$/s);
      return (JSON.parse(m?.[1] ?? '[]') as unknown[]).length;
    });
    expect(sizes.sort((a, b) => b - a)).toEqual([100, 50]);

    // All 150 must be in cache.
    const keys = await Promise.all(inputs.map((i) => __test.cacheKey(el.code, i.lexeme.text)));
    const stored = await storage.get(keys);
    expect(Object.keys(stored)).toHaveLength(150);
  });

  it('honors a custom batchSize', async () => {
    const inputs = [needsLlm('a'), needsLlm('b'), needsLlm('c'), needsLlm('d'), needsLlm('e')];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(((init?.body as string) ?? '') || '{}') as {
        messages: { content: string }[];
      };
      const content = body.messages[0]?.content ?? '';
      const m = content.match(/Lexemes to enrich[^:]*:\n(\[.*\])$/s);
      const parsed = JSON.parse(m?.[1] ?? '[]') as { text: string }[];
      return mockToolResponse(
        parsed.map((l) => makeEnrichment({ text: l.text, pos: 'verb', lemma: l.text })),
      );
    }) as unknown as typeof fetch;

    await enrichLexemes(inputs, {
      apiKey: 'sk',
      languageModule: el,
      batchSize: 2,
      storage: memoryStorage(),
      fetchImpl,
    });
    // 5 inputs / batchSize 2 = 3 calls (2, 2, 1).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('enrichLexemes — LLM omissions', () => {
  it('re-queues missing items so a subsequent batch picks them up', async () => {
    // Haiku occasionally drops an entry from a tool-call array on large
    // batches (user-reported: ζέβρα disappeared from a 100-item run). The
    // queue-based loop should pick up the dropped entry on the next batch.
    const inputs = [needsLlm('a'), needsLlm('b'), needsLlm('c')];
    let callIdx = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callIdx += 1;
      const body = JSON.parse(((init?.body as string) ?? '') || '{}') as {
        messages: { content: string }[];
      };
      const content = body.messages[0]?.content ?? '';
      const m = content.match(/Lexemes to enrich[^:]*:\n(\[.*\])$/s);
      const parsed = JSON.parse(m?.[1] ?? '[]') as { text: string }[];
      // First call: drop 'b'. Second call: return whatever we got.
      const texts = parsed.map((p) => p.text);
      const returned = callIdx === 1 ? texts.filter((t) => t !== 'b') : texts;
      return mockToolResponse(
        returned.map((t) => makeEnrichment({ text: t, pos: 'verb', lemma: t })),
      );
    }) as unknown as typeof fetch;

    const storage = memoryStorage();
    const result = await enrichLexemes(inputs, {
      apiKey: 'sk',
      languageModule: el,
      storage,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.text)).toEqual(['a', 'b', 'c']);
    // Second call received only the dropped item.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const secondInit = (calls[1] as [string, RequestInit])[1];
    const secondBody = JSON.parse(secondInit.body as string) as {
      messages: { content: string }[];
    };
    const secondMatch = secondBody.messages[0]?.content.match(
      /Lexemes to enrich[^:]*:\n(\[.*\])$/s,
    );
    const secondParsed = JSON.parse(secondMatch?.[1] ?? '[]') as { text: string }[];
    expect(secondParsed.map((p) => p.text)).toEqual(['b']);
    // Cache populated for all three (including the recovered one).
    const keys = await Promise.all(inputs.map((i) => __test.cacheKey(el.code, i.lexeme.text)));
    const stored = await storage.get(keys);
    expect(Object.keys(stored)).toHaveLength(3);
  });

  it('throws after repeatedly omitting the same item', async () => {
    // If the LLM refuses an input three times in a row, give up rather than
    // looping forever. Three is enough for transient drops; persistent
    // refusal is a real signal worth surfacing.
    const fetchImpl = vi.fn(async () => mockToolResponse([])) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('a')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/repeatedly omitted "a".*3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('enrichLexemes — per-batch progress', () => {
  function echoFetch(): typeof fetch {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(((init?.body as string) ?? '') || '{}') as {
        messages: { content: string }[];
      };
      const content = body.messages[0]?.content ?? '';
      const m = content.match(/Lexemes to enrich[^:]*:\n(\[.*\])$/s);
      const parsed = JSON.parse(m?.[1] ?? '[]') as { text: string }[];
      return mockToolResponse(parsed.map((p) => makeEnrichment({ text: p.text, lemma: p.text })));
    }) as unknown as typeof fetch;
  }

  it('emits (enriched, total) before each batch plus a final tick', async () => {
    const inputs = ['a', 'b', 'c', 'd', 'e'].map((t) => needsLlm(t));
    const progress: Array<[number, number]> = [];
    await enrichLexemes(inputs, {
      apiKey: 'sk',
      languageModule: el,
      storage: memoryStorage(),
      fetchImpl: echoFetch(),
      batchSize: 2,
      onProgress: (enriched, total) => progress.push([enriched, total]),
    });
    // 5 LLM-bound words / batchSize 2 = 3 batches → 3 pre-call ticks + 1 final.
    expect(progress).toEqual([
      [0, 5],
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('does not call onProgress when nothing is LLM-bound (all synthesized)', async () => {
    const inputs = [passthrough('γεύμα'), passthrough('όνομα')];
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not reach the API');
    }) as unknown as typeof fetch;
    let calls = 0;
    const result = await enrichLexemes(inputs, {
      apiKey: 'sk',
      languageModule: el,
      storage: memoryStorage(),
      fetchImpl,
      onProgress: () => {
        calls += 1;
      },
    });
    expect(result).toHaveLength(2);
    expect(calls).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('enrichLexemes — mixed (cached + pass-through + LLM)', () => {
  it('sends exactly the LLM-bound subset to the API and returns all results in input order', async () => {
    // 10 inputs:
    // - 3 cached (verb lemmas) at positions 0, 4, 7
    // - 4 pass-through (high-confidence -μα nouns) at positions 1, 2, 6, 9
    // - 3 LLM-bound at positions 3, 5, 8
    const cachedTexts = ['διαβάζω', 'γράφω', 'τρώω'];
    const passthroughTexts = ['γεύμα', 'όνομα', 'σύστημα', 'δράμα'];
    const llmTexts = ['πελεκάνος', 'οδός', 'λάθος'];

    const cachedEnrichments = new Map<string, Enrichment>();
    const storageInit: Record<string, unknown> = {};
    for (const t of cachedTexts) {
      const e = makeEnrichment({ text: t, pos: 'verb', lemma: t, inflection: '1sg present' });
      cachedEnrichments.set(t, e);
      const k = await __test.cacheKey(el.code, t);
      storageInit[k] = { enrichment: e, cachedAt: 1 };
    }

    const inputs: EnrichmentInput[] = [
      needsLlm(cachedTexts[0]!),
      passthrough(passthroughTexts[0]!),
      passthrough(passthroughTexts[1]!),
      needsLlm(llmTexts[0]!),
      needsLlm(cachedTexts[1]!),
      needsLlm(llmTexts[1]!),
      passthrough(passthroughTexts[2]!),
      needsLlm(cachedTexts[2]!),
      needsLlm(llmTexts[2]!),
      passthrough(passthroughTexts[3]!),
    ];

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(((init?.body as string) ?? '') || '{}') as {
        messages: { content: string }[];
      };
      const content = body.messages[0]?.content ?? '';
      const m = content.match(/Lexemes to enrich[^:]*:\n(\[.*\])$/s);
      const parsed = JSON.parse(m?.[1] ?? '[]') as { text: string }[];
      // Verify the body holds only the 3 LLM-bound texts.
      const texts = parsed.map((p) => p.text).sort();
      expect(texts).toEqual([...llmTexts].sort());
      return mockToolResponse(
        parsed.map((l) =>
          makeEnrichment({ text: l.text, pos: 'noun', gender: 'm', article: 'ο', lemma: l.text }),
        ),
      );
    }) as unknown as typeof fetch;

    const storage = memoryStorage(storageInit);
    const result = await enrichLexemes(inputs, {
      apiKey: 'sk',
      languageModule: el,
      storage,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(10);
    expect(result.map((r) => r.text)).toEqual([
      cachedTexts[0],
      passthroughTexts[0],
      passthroughTexts[1],
      llmTexts[0],
      cachedTexts[1],
      llmTexts[1],
      passthroughTexts[2],
      cachedTexts[2],
      llmTexts[2],
      passthroughTexts[3],
    ]);
    expect(result[0]).toEqual(cachedEnrichments.get(cachedTexts[0]!));
    expect(result[1]?.pos).toBe('noun');
    expect(result[1]?.article).toBe('το');
    expect(result[3]?.pos).toBe('noun'); // LLM-returned
  });
});

describe('enrichLexemes — validation', () => {
  it('throws when an enrichment is missing a required field', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([{ text: 'γράφω', pos: 'verb' /* no lemma */ }]),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/"γράφω".*lemma/);
  });

  it('throws when an enrichment has an invalid pos', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([{ text: 'γράφω', pos: 'gerund', lemma: 'γράφω' }]),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid.*pos/);
  });

  it('throws when an enrichment has an out-of-enum article', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        // 'τη' is the accusative article — the schema's enum is the
        // nominative-only set {ο, η, το, οι, τα}.
        { text: 'γράφω', pos: 'noun', article: 'τη', lemma: 'γράφω' },
      ]),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid article/);
  });

  it('force-nulls an out-of-enum article on a non-noun instead of throwing (the word "les")', async () => {
    // Regression: the French definite article "les" is itself a vocabulary
    // word. Haiku classifies it pos:"article" and echoes "les" into the
    // article field — which is NOT in fr's indefinite-only {un, une, des}.
    // The enum checks are gated on isNoun, so a non-noun's article/gender/
    // number are force-nulled rather than aborting the whole sync over a value
    // that never reaches Anki. (A NOUN with a bad article still throws — see
    // the test above.)
    const input: EnrichmentInput = {
      lexeme: lex('les', ['the']),
      morphology: {
        text: 'les',
        pos: 'unknown',
        gender: null,
        number: null,
        article: null,
        confidence: 'low',
        reason: 'no morphology rule matched',
        needsEnrichment: true,
      },
    };
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        {
          text: 'les',
          pos: 'article',
          gender: 'm', // bogus on a non-noun → force-nulled
          number: 'plural', // ditto
          article: 'les', // out of fr's {un,une,des} → force-nulled, not thrown
          lemma: 'les',
          notes: 'plural definite article',
        },
      ]),
    ) as unknown as typeof fetch;
    const result = await enrichLexemes([input], {
      apiKey: 'sk',
      languageModule: fr,
      storage: memoryStorage(),
      fetchImpl,
    });
    expect(result[0]).toMatchObject({
      text: 'les',
      pos: 'article',
      gender: null,
      number: null,
      article: null,
      lemma: 'les',
      notes: 'plural definite article',
    });
  });

  it('strips article, gender, number on non-nouns even when LLM returns them', async () => {
    // Regression: Haiku occasionally returns e.g. `pos:"adjective",
    // article:"ο"` for μάλλινος. Without sanitization these phantom fields
    // surface in Anki as "ο μάλλινος" — the article belongs to the modified
    // noun, not to the adjective itself.
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        {
          text: 'μάλλινος',
          pos: 'adjective',
          gender: 'm',
          number: 'singular',
          article: 'ο',
          lemma: 'μάλλινος',
          notes: 'woollen',
        },
      ]),
    ) as unknown as typeof fetch;
    const result = await enrichLexemes([needsLlm('μάλλινος')], {
      apiKey: 'sk',
      languageModule: el,
      storage: memoryStorage(),
      fetchImpl,
    });
    expect(result[0]).toMatchObject({
      text: 'μάλλινος',
      pos: 'adjective',
      gender: null,
      number: null,
      article: null,
      lemma: 'μάλλινος',
      notes: 'woollen',
    });
  });

  it('preserves gender/number/article on nouns', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        {
          text: 'σκύλοι',
          pos: 'noun',
          gender: 'm',
          number: 'plural',
          article: 'οι',
          lemma: 'σκύλος',
          inflection: 'plural of σκύλος',
        },
      ]),
    ) as unknown as typeof fetch;
    const result = await enrichLexemes([needsLlm('σκύλοι')], {
      apiKey: 'sk',
      languageModule: el,
      storage: memoryStorage(),
      fetchImpl,
    });
    expect(result[0]).toMatchObject({
      pos: 'noun',
      gender: 'm',
      number: 'plural',
      article: 'οι',
      lemma: 'σκύλος',
    });
  });

  it('accepts pos="article" for Greek articles like οι/η/το', async () => {
    // Regression: the LLM correctly classifies οι/τα/τον/την as `article`
    // (the precise Greek grammatical category). Before adding article to the
    // enum, validation rejected the whole batch and the sync aborted before
    // touching Anki. Sanitization still strips noun-only fields.
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        {
          text: 'οι',
          pos: 'article',
          gender: 'm',
          number: 'plural',
          article: null,
          lemma: 'οι',
          notes: 'masc/fem nominative plural definite article',
        },
      ]),
    ) as unknown as typeof fetch;
    const result = await enrichLexemes([needsLlm('οι')], {
      apiKey: 'sk',
      languageModule: el,
      storage: memoryStorage(),
      fetchImpl,
    });
    expect(result[0]).toMatchObject({
      text: 'οι',
      pos: 'article',
      // Stripped: gender/number/article are noun-only attributes.
      gender: null,
      number: null,
      article: null,
      lemma: 'οι',
      notes: 'masc/fem nominative plural definite article',
    });
  });

  it('accepts null article (for non-nouns)', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([{ text: 'γράφω', pos: 'verb', article: null, lemma: 'γράφω' }]),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).resolves.toHaveLength(1);
  });

  it('throws when the response has no tool_use block', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tool used' }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/no tool_use block/);
  });

  it('includes the offending tool input when enrichments is not an array (diagnostic)', async () => {
    // Regression: when Haiku ignores the schema (here it wraps the result in an
    // object instead of an array), the structural error must surface WHAT came
    // back so the failure is diagnosable from the service-worker console rather
    // than an opaque "is not an array".
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'tool_use',
                name: 'record_enrichments',
                input: { enrichments: { unexpected: 'object-instead-of-array' } },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/enrichments is not an array.*object-instead-of-array/s);
  });

  it('throws a specific truncation error when stop_reason=max_tokens', async () => {
    // Even though the tool_use block looks well-formed here, the dedicated
    // truncation check should fire *before* we hand the (potentially partial)
    // input to validateEnrichment, so the user gets an actionable error.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            stop_reason: 'max_tokens',
            content: [
              {
                type: 'tool_use',
                name: 'record_enrichments',
                input: { enrichments: [{ text: 'γράφω', pos: 'verb', lemma: 'γράφω' }] },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/truncated.*max_tokens/);
  });
});

describe('enrichLexemes — API errors', () => {
  it('throws on HTTP 401 with the status and body excerpt', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('invalid api key', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk-bad',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/401.*invalid api key/);
  });

  it('throws on HTTP 429 (rate limit) with the status and body excerpt', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('γράφω')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/429.*rate limited/);
  });
});

describe('enrichLexemes — text echo mismatch', () => {
  it('throws when an enrichment text does not match any input lexeme', async () => {
    const fetchImpl = vi.fn(async () =>
      mockToolResponse([
        // Note: input was 'παιδί' (final stressed iota); LLM returned an
        // un-stressed mangled form.
        { text: 'παιδι', pos: 'noun', lemma: 'παιδί' },
      ]),
    ) as unknown as typeof fetch;
    await expect(
      enrichLexemes([needsLlm('παιδί')], {
        apiKey: 'sk',
        languageModule: el,
        storage: memoryStorage(),
        fetchImpl,
      }),
    ).rejects.toThrow(/does not match any input lexeme/);
  });
});

describe('memoryStorage', () => {
  it('returns only the keys that were set', async () => {
    const s = memoryStorage({ a: 1, b: 2 });
    const r = await s.get(['a', 'c']);
    expect(r).toEqual({ a: 1 });
  });

  it('merges set() into existing data without dropping unrelated keys', async () => {
    const s = memoryStorage({ a: 1 });
    await s.set({ b: 2 });
    const r = await s.get(['a', 'b']);
    expect(r).toEqual({ a: 1, b: 2 });
  });
});

describe('chromeStorageAdapter', () => {
  it('forwards get and set calls to the supplied StorageArea', async () => {
    const get = vi.fn(async (_k: string[]) => ({ foo: 'bar' }));
    const set = vi.fn(async (_items: Record<string, unknown>) => {});
    const fakeArea = { get, set } as unknown as chrome.storage.StorageArea;
    const s: Storage = chromeStorageAdapter(fakeArea);
    expect(await s.get(['foo'])).toEqual({ foo: 'bar' });
    await s.set({ foo: 'baz' });
    expect(get).toHaveBeenCalledWith(['foo']);
    expect(set).toHaveBeenCalledWith({ foo: 'baz' });
  });
});
