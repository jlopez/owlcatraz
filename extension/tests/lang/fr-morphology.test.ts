import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inferMorphology } from '../../src/lib/lang/fr';
import type {
  Confidence,
  Gender,
  GrammaticalNumber,
  MorphologyResult,
  POS,
} from '../../src/lib/lang/types';
import { isLexeme, type Lexeme } from '../../src/types';

const here = dirname(fileURLToPath(import.meta.url));
// tests/lang → repo-root/fixtures/fr
const fixturesDir = resolve(here, '../../../fixtures/fr');

function loadJSON(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

function lex(text: string): Lexeme {
  return { text, translations: [], audioURL: null, isNew: false };
}

interface GoldenRow {
  text: string;
  pos: POS;
  gender: Gender | null;
  number: GrammaticalNumber | null;
  article: string | null;
  confidence: Confidence;
  needsEnrichment: boolean;
  // Substring the `reason` must contain — discriminates which rule fired so a
  // reason/rule swap during refactor is caught. Light touch (not exact match)
  // so reason copy-edits don't break the suite.
  reasonMatch: string;
}

const GOLDEN: GoldenRow[] = [
  // Rule 1 — phrases (incl. reflexive verbs caught by the whitespace test)
  {
    text: 'se garer',
    pos: 'phrase',
    gender: null,
    number: null,
    article: null,
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: 'phrase',
  },
  {
    text: 'marchand de journaux',
    pos: 'phrase',
    gender: null,
    number: null,
    article: null,
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: 'phrase',
  },
  // Rule 2 — -tion / -sion / -xion feminine (high), article une
  {
    text: 'information',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-tion',
  },
  {
    text: 'télévision',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-sion',
  },
  {
    text: 'connexion',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-xion',
  },
  // Rule 3 — -té feminine (high)
  {
    text: 'liberté',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-té',
  },
  {
    text: 'université',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-té',
  },
  // Rule 4 — -ée feminine (high)
  {
    text: 'arrivée',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ée',
  },
  {
    text: 'idée',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'une',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ée',
  },
  // Rule 5 — -ment masculine (high), article un
  {
    text: 'gouvernement',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ment',
  },
  {
    text: 'moment',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ment',
  },
  {
    text: 'appartement',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ment',
  },
  // Rule 6 — -eau / -eu masculine (medium)
  {
    text: 'bureau',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-eau',
  },
  {
    text: 'cheveu',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-eu',
  },
  // Rule 7 — -age masculine (low, needs LLM confirm)
  {
    text: 'fromage',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-age',
  },
  {
    text: 'voyage',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'un',
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-age',
  },
  // Rule 7 feminine exceptions — fall through to the LLM as unknown
  {
    text: 'image',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
  {
    text: 'plage',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
  // Rule 8 — -er / -ir / -re verb infinitive (low)
  {
    text: 'manger',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-er/-ir/-re',
  },
  {
    text: 'finir',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-er/-ir/-re',
  },
  {
    text: 'prendre',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-er/-ir/-re',
  },
  // Rule 8 noun homograph — tagged verb (low + needs LLM), the documented
  // imprecision; the LLM reclassifies "hiver" (winter) as a noun.
  {
    text: 'hiver',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-er/-ir/-re',
  },
  // Rule 5 exclusion — jument (mare) must NOT synthesize "un jument"
  {
    text: 'jument',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
  // Length-guard edges — too short for their suffix rule, fall through
  {
    text: 'mer',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
  {
    text: 'feu',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
  // Rule 9 — default unknowns (irregular nouns, adjectives)
  {
    text: 'chien',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
  {
    text: 'rouge',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
];

describe('inferMorphology (fr) — golden set', () => {
  for (const row of GOLDEN) {
    it(`tags "${row.text}" correctly`, () => {
      const result = inferMorphology(lex(row.text));
      expect(result.text).toBe(row.text);
      expect(result.pos).toBe(row.pos);
      expect(result.gender).toBe(row.gender);
      expect(result.number).toBe(row.number);
      expect(result.article).toBe(row.article);
      expect(result.confidence).toBe(row.confidence);
      expect(result.needsEnrichment).toBe(row.needsEnrichment);
      expect(result.reason).toContain(row.reasonMatch);
    });
  }
});

describe('inferMorphology (fr) — coverage statistics on the 50-word fixture', () => {
  const lexemes = loadJSON('all-lexemes.json') as Lexeme[];

  it('every fixture entry passes the isLexeme guard', () => {
    // Defense in depth — fixtures.test.ts validates this too, but vitest
    // doesn't guarantee inter-file ordering and a malformed fixture would
    // crash inside inferMorphology with a useless error otherwise.
    expect((lexemes as unknown[]).every(isLexeme)).toBe(true);
  });

  it('classifies every entry without throwing and meets coverage floors', () => {
    const results: MorphologyResult[] = lexemes.map(inferMorphology);
    expect(results).toHaveLength(50);

    const phraseCount = results.filter((r) => r.pos === 'phrase').length;
    const highConfCount = results.filter((r) => r.confidence === 'high').length;
    const noEnrichCount = results.filter((r) => !r.needsEnrichment).length;
    const needsEnrichCount = results.filter((r) => r.needsEnrichment).length;

    // Floors set at the synthesized 50-word fixture's actual distribution:
    // 5 phrases; 24 high-confidence (5 phrase + 5 -tion/-sion/-xion + 4 -té +
    // 4 -ée + 6 -ment); 29 no-enrich (the 24 high + 5 medium -eau/-eu); 21
    // needs-enrich (3 -age + 6 verb + 12 unknown). At-or-just-below measured so
    // a regression disabling any single rule trips this test — each rule
    // contributes >= 4 hits to the fixture.
    expect(phraseCount).toBe(5); // exact: phrases are a fixture invariant
    expect(highConfCount).toBeGreaterThanOrEqual(24);
    expect(noEnrichCount).toBeGreaterThanOrEqual(29);
    expect(needsEnrichCount).toBeGreaterThanOrEqual(21);

    expect(noEnrichCount + needsEnrichCount).toBe(results.length);
  });

  it('every synthesized (high-confidence, no-enrich) noun carries an indefinite article', () => {
    // The whole reason French uses un/une instead of le/la: gender must stay
    // visible. Guard that the synth path never emits a definite or elided
    // article — only un / une (des would be plural, which the high path never
    // produces).
    const synthNouns = lexemes
      .map(inferMorphology)
      .filter((r) => r.pos === 'noun' && r.confidence === 'high' && !r.needsEnrichment);
    expect(synthNouns.length).toBeGreaterThan(0);
    for (const r of synthNouns) {
      expect(r.article === 'un' || r.article === 'une').toBe(true);
      expect(r.number).toBe('singular');
    }
  });
});

describe('inferMorphology (fr) — rule 7 -age feminine exceptions', () => {
  // Regression: -age defaults masculine, but a productive feminine subset must
  // NOT be synthesized as "un <word>". These fall through to the LLM.
  it.each(['image', 'page', 'cage', 'nage', 'plage', 'rage'])(
    'does not tag "%s" as masculine -age',
    (text) => {
      const result = inferMorphology(lex(text));
      if (result.pos === 'noun' && result.article !== null) {
        expect(result.reason).not.toContain('-age');
      }
      // Either way it must be flagged for the LLM rather than confidently typed.
      expect(result.needsEnrichment).toBe(true);
    },
  );

  it('still tags genuine masculine -age nouns at low confidence', () => {
    for (const text of ['fromage', 'voyage', 'message', 'garage']) {
      const result = inferMorphology(lex(text));
      expect(result.pos).toBe('noun');
      expect(result.gender).toBe('m');
      expect(result.article).toBe('un');
      expect(result.confidence).toBe('low');
      expect(result.reason).toContain('-age');
    }
  });
});

describe('inferMorphology (fr) — edge cases', () => {
  it('returns pos=unknown on an empty string without throwing', () => {
    const result = inferMorphology(lex(''));
    expect(result.pos).toBe('unknown');
    expect(result.gender).toBeNull();
    expect(result.article).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.needsEnrichment).toBe(true);
  });

  it('excludes "été" from the -té feminine rule', () => {
    const result = inferMorphology(lex('été'));
    expect(result.pos).toBe('unknown');
  });

  it('excludes "jument" from the -ment masculine rule', () => {
    const result = inferMorphology(lex('jument'));
    expect(result.pos).toBe('unknown');
  });

  it('respects the length guard on -eau / -eu (feu, jeu stay unknown)', () => {
    for (const text of ['feu', 'jeu']) {
      expect(inferMorphology(lex(text)).pos).toBe('unknown');
    }
  });

  it('respects the length guard on -er (mer stays unknown, not a verb)', () => {
    expect(inferMorphology(lex('mer')).pos).toBe('unknown');
  });

  it('trims leading/trailing whitespace before applying rules', () => {
    // Defensive: a wrapped single word must not be mis-tagged as a phrase.
    const result = inferMorphology(lex(' moment '));
    expect(result.pos).toBe('noun');
    expect(result.gender).toBe('m');
    expect(result.article).toBe('un');
  });
});
