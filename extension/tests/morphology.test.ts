import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inferMorphology } from '../src/lib/lang/el';
import type {
  Confidence,
  Gender,
  GrammaticalNumber,
  MorphologyResult,
  POS,
} from '../src/lib/lang/types';
import { isLexeme, type Lexeme } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../fixtures');

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
  // Substring the `reason` must contain — discriminates the rule that fired
  // so a reason/rule swap during refactor is caught. Light touch (not exact
  // match) so reason copy-edits don't break the suite.
  reasonMatch: string;
}

const GOLDEN: GoldenRow[] = [
  {
    text: 'δράμα',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-μα',
  },
  {
    text: 'όνομα',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-μα',
  },
  {
    text: 'γεύμα',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-μα',
  },
  {
    text: 'παιδί',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ι',
  },
  {
    text: 'ρύζι',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: '-ι',
  },
  {
    text: 'ελέφαντας',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'ο',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-ας',
  },
  {
    text: 'μαθητής',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'ο',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-ας',
  },
  {
    text: 'μπαμπάς',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'ο',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-ας',
  },
  {
    text: 'σκύλος',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'ο',
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-ος',
  },
  {
    text: 'πελεκάνος',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'ο',
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-ος',
  },
  {
    text: 'νόστιμος',
    pos: 'noun',
    gender: 'm',
    number: 'singular',
    article: 'ο',
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: '-ος',
  },
  {
    text: 'ζάχαρη',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'η',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-η',
  },
  {
    text: 'αδελφή',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'η',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-η',
  },
  {
    text: 'γραβάτα',
    pos: 'noun',
    gender: 'f',
    number: 'singular',
    article: 'η',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-α',
  },
  {
    text: 'πουκάμισο',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-ο',
  },
  {
    text: 'λουκάνικο',
    pos: 'noun',
    gender: 'n',
    number: 'singular',
    article: 'το',
    confidence: 'medium',
    needsEnrichment: false,
    reasonMatch: '-ο',
  },
  {
    text: 'διαβάζω',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'medium',
    needsEnrichment: true,
    reasonMatch: '-ω',
  },
  {
    text: 'ευχαριστώ',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'medium',
    needsEnrichment: true,
    reasonMatch: '-ω',
  },
  {
    text: 'εγώ',
    pos: 'verb',
    gender: null,
    number: null,
    article: null,
    confidence: 'medium',
    needsEnrichment: true,
    reasonMatch: '-ω',
  },
  {
    text: 'με συγχωρείτε',
    pos: 'phrase',
    gender: null,
    number: null,
    article: null,
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: 'phrase',
  },
  {
    text: 'πώς είσαι',
    pos: 'phrase',
    gender: null,
    number: null,
    article: null,
    confidence: 'high',
    needsEnrichment: false,
    reasonMatch: 'phrase',
  },
  {
    text: 'διαβάζεις',
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    needsEnrichment: true,
    reasonMatch: 'no morphology rule matched',
  },
];

describe('inferMorphology — golden set', () => {
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

describe('inferMorphology — coverage statistics on the 50-word fixture', () => {
  const lexemes = loadJSON('all-lexemes.json') as Lexeme[];

  it('every fixture entry passes the isLexeme guard', () => {
    // Defense in depth — fixtures.test.ts already validates this, but vitest
    // doesn't guarantee inter-file ordering, and a malformed fixture would
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

    // Floors set against the synthesized 50-word fixture's actual distribution:
    // 5 phrases, 14 high-confidence (phrase + -μα + -ι), 35 no-enrich, 15
    // needs-enrich. Floors sit at or just below measured so a regression that
    // disables any single rule fails this test (each rule contributes >= 4
    // hits to the fixture).
    expect(phraseCount).toBe(5); // exact: phrases are a fixture invariant
    expect(highConfCount).toBeGreaterThanOrEqual(14);
    expect(noEnrichCount).toBeGreaterThanOrEqual(35);
    expect(needsEnrichCount).toBeGreaterThanOrEqual(15);

    expect(noEnrichCount + needsEnrichCount).toBe(results.length);
  });
});

describe('inferMorphology — rule 3 exclusions for -οι / -ει / -αι', () => {
  // Regression: rule 3 used to catch any -ι/-ί ending as high-confidence
  // neuter singular, which mis-tagged masculine plurals (σκύλοι → "το
  // σκύλοι"), 3sg verbs (παίζει → "το παίζει"), and είναι → "το είναι".
  // These three suffixes must NOT match rule 3; they fall through to the
  // LLM (rule 10 default).
  it.each([
    ['σκύλοι', 'masc plural of σκύλος'],
    ['φίλοι', 'masc plural of φίλος'],
    ['κύριοι', 'masc plural of κύριος'],
    ['παίζει', '3sg of παίζω'],
    ['γράφει', '3sg of γράφω'],
    ['τρώει', '3sg of τρώω'],
    ['είναι', '3sg/3pl of είμαι'],
  ])('does not tag "%s" (%s) as high-confidence neuter', (text) => {
    const result = inferMorphology(lex(text));
    expect(result.confidence).not.toBe('high');
    // Either falls through to rule 10 (unknown, needsEnrichment), or to
    // another medium rule — either way, never claims neuter-singular -ι.
    if (result.pos === 'noun' && result.gender === 'n' && result.article === 'το') {
      // -οι/-ει/-αι should never reach the rule-3 neuter synthesis path.
      expect(result.reason).not.toContain('-ι');
    }
  });

  it('still tags genuine -ι/-ί singular neuter nouns at high confidence', () => {
    // Defense against an over-broad exclusion that would drop the rule
    // entirely. The rule must still fire for canonical -ι neuters.
    for (const text of ['παιδί', 'σπίτι', 'αγόρι', 'ψωμί']) {
      const result = inferMorphology(lex(text));
      expect(result.confidence).toBe('high');
      expect(result.pos).toBe('noun');
      expect(result.gender).toBe('n');
      expect(result.article).toBe('το');
    }
  });
});

describe('inferMorphology — edge cases', () => {
  it('returns pos=unknown on an empty string without throwing', () => {
    const result = inferMorphology(lex(''));
    expect(result.pos).toBe('unknown');
    expect(result.gender).toBeNull();
    expect(result.article).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.needsEnrichment).toBe(true);
  });

  it('classifies "μα" as unknown (rule-2 length guard rejects the conjunction)', () => {
    const result = inferMorphology(lex('μα'));
    expect(result.pos).toBe('unknown');
  });

  it('classifies "ο" as unknown (length guard on rule 9)', () => {
    const result = inferMorphology(lex('ο'));
    expect(result.pos).toBe('unknown');
  });

  it('trims leading/trailing whitespace before applying rules', () => {
    // Defensive: a wrapped single word must not be mis-tagged as a phrase.
    const result = inferMorphology(lex(' όνομα '));
    expect(result.pos).toBe('noun');
    expect(result.gender).toBe('n');
    expect(result.article).toBe('το');
  });
});
