import type { Lexeme } from '../../types';
import type { EnrichmentGender, FewShot, LanguageModule, MorphologyResult } from './types';

function endsWithAny(text: string, suffixes: readonly string[]): boolean {
  for (const s of suffixes) {
    if (text.endsWith(s)) return true;
  }
  return false;
}

// Rule 7: -age is masculine by default, but a handful of very common nouns are
// feminine. Excluding them (rather than mis-tagging them masculine) sends them
// to the LLM as `unknown` instead of confidently-wrong — same defensive pattern
// as Greek's -οι/-ει/-αι exclusions on its rule 3.
const AGE_FEMININE_EXCEPTIONS: ReadonlySet<string> = new Set([
  'image',
  'page',
  'cage',
  'nage',
  'plage',
  'rage',
]);

// Rule 5: -ment is overwhelmingly masculine (it's the productive adverb/noun
// suffix), but `jument` (mare) is feminine. Exclude it so it falls through to
// the LLM rather than synthesizing "un jument".
const MENT_EXCEPTIONS: ReadonlySet<string> = new Set(['jument']);

export function inferMorphology(lexeme: Lexeme): MorphologyResult {
  // Trim defensively — see the matching note in el.ts. A whitespace-wrapped
  // single word would otherwise match rule 1 (phrase) at confidence=high,
  // confidently wrong and not flagged for the LLM.
  const text = lexeme.text.trim();

  // Rule 1: phrase (contains internal whitespace). Catches multi-word phrases
  // and reflexive verbs alike (`se garer`, `marchand de journaux`); the LLM
  // resolves the finer structure.
  if (/\s/.test(text)) {
    return {
      text,
      pos: 'phrase',
      gender: null,
      number: null,
      article: null,
      confidence: 'high',
      reason: 'multi-word phrase',
      needsEnrichment: false,
    };
  }

  // Rule 2: -tion / -sion / -xion feminine (high), length > 5. The classic
  // productive feminine suffix (information, télévision, connexion). Article is
  // the *indefinite* `une` — French uses the indefinite article on cards so the
  // gender stays visible on vowel-initial nouns (definite `la`/`le` both elide
  // to `l'`, hiding gender on exactly the words it's hardest to guess). See the
  // systemPrompt note.
  if (text.length > 5 && endsWithAny(text, ['tion', 'sion', 'xion'])) {
    return {
      text,
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      article: 'une',
      confidence: 'high',
      reason: '-tion/-sion/-xion ending → feminine',
      needsEnrichment: false,
    };
  }

  // Rule 3: -té feminine (high), length > 3, excluding `été` (summer / been —
  // masculine noun and past participle). liberté, université, société.
  if (text.length > 3 && text.endsWith('té') && text !== 'été') {
    return {
      text,
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      article: 'une',
      confidence: 'high',
      reason: '-té ending → feminine',
      needsEnrichment: false,
    };
  }

  // Rule 4: -ée feminine (high), length > 3. arrivée, journée, idée. Some -ée
  // forms are past participles used adjectivally; when the surface form is a
  // noun (which is how Duolingo emits them) feminine singular is correct, and
  // the LLM resolves the participle/adjective overlap from context anyway.
  if (text.length > 3 && text.endsWith('ée')) {
    return {
      text,
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      article: 'une',
      confidence: 'high',
      reason: '-ée ending → feminine',
      needsEnrichment: false,
    };
  }

  // Rule 5: -ment masculine (high), length > 4, excluding `jument`. The
  // productive masculine noun suffix (gouvernement, mouvement, moment).
  if (text.length > 4 && text.endsWith('ment') && !MENT_EXCEPTIONS.has(text)) {
    return {
      text,
      pos: 'noun',
      gender: 'm',
      number: 'singular',
      article: 'un',
      confidence: 'high',
      reason: '-ment ending → masculine',
      needsEnrichment: false,
    };
  }

  // Rule 6: -eau / -eu masculine (medium), length > 3. bureau, château, cheveu.
  // Medium rather than high — feminine exceptions exist (eau itself, peau) and
  // some -eu forms are verb conjugations. The morphology_hint anchors the LLM;
  // needsEnrichment stays false so high-volume regular cases skip a re-check.
  if (text.length > 3 && endsWithAny(text, ['eau', 'eu'])) {
    return {
      text,
      pos: 'noun',
      gender: 'm',
      number: 'singular',
      article: 'un',
      confidence: 'medium',
      reason: '-eau/-eu ending → masculine',
      needsEnrichment: false,
    };
  }

  // Rule 7: -age masculine (LOW), length > 3, with a feminine-exception set.
  // Many noun homographs and a productive feminine subset (image, plage); low
  // confidence and needsEnrichment so the LLM always confirms.
  if (text.length > 3 && text.endsWith('age') && !AGE_FEMININE_EXCEPTIONS.has(text)) {
    return {
      text,
      pos: 'noun',
      gender: 'm',
      number: 'singular',
      article: 'un',
      confidence: 'low',
      reason: '-age ending → usually masculine, exceptions exist (une image, une plage)',
      needsEnrichment: true,
    };
  }

  // Rule 8: -er / -ir / -re verb infinitive (LOW), length > 3. Heavy noun
  // homograph overlap (mer, hiver, frère, livre), so low confidence and
  // needsEnrichment — the LLM reclassifies the nouns. Surfaces as a verb hint
  // because the infinitive is the dominant reading for these endings.
  if (text.length > 3 && endsWithAny(text, ['er', 'ir', 're'])) {
    return {
      text,
      pos: 'verb',
      gender: null,
      number: null,
      article: null,
      confidence: 'low',
      reason:
        '-er/-ir/-re ending → likely verb infinitive (noun homographs exist — LLM to confirm)',
      needsEnrichment: true,
    };
  }

  // Rule 9: default
  return {
    text,
    pos: 'unknown',
    gender: null,
    number: null,
    article: null,
    confidence: 'low',
    reason: 'no morphology rule matched',
    needsEnrichment: true,
  };
}

const SYSTEM_PROMPT = `You are a French linguistics assistant. For each French lexeme provided, return precise grammatical metadata via the record_enrichments tool.

Rules:
- "text" must echo the input exactly, character for character.
- For nouns: provide gender (m/f), number (singular/plural), and the INDEFINITE article (un/une/des). Use the indefinite article — never the definite (le/la/l'/les). The indefinite article never elides, so the gender stays visible even before a vowel ("une eau", "un homme"), which is the whole point of showing an article on the card. For plurals, also provide the singular form as "lemma".
- The "gender" and "article" fields each take exactly ONE value. NEVER return a combined value such as "m/f" or "un/une". Many French nouns are epicene (one form for both genders: secrétaire, élève, enfant, touriste, artiste, collègue). For these, pick the gender the translation/context indicates; if it is genuinely ambiguous, use the masculine ("m" / "un") as the citation form, and record the dual gender in "notes" (e.g. "épicène : un/une secrétaire").
- For verbs: provide the INFINITIVE as "lemma" (e.g. arriver, finir), not a conjugated form. Note inflection details succinctly (e.g. "past participle of arriver", "1sg present of aller").
- For adjectives: provide the masculine singular as "lemma".
- For phrases, pronouns, particles: lemma = the input text itself.
- Function words that are themselves articles, determiners, or pronouns (le, la, les, des, un, une, ce, mon, je, qui …) are NOT nouns. Classify them as "article", "pronoun", or "other" and leave gender, number, and article null — do not echo the word back into the article field.
- The morphology_hint with confidence="high" should be treated as anchoring — do not override unless the hint is clearly wrong for this input.
- Do NOT correct the user's French; metadata reflects the form provided.`;

// Indefinite article — un/une/des. French cards use the indefinite article (not
// the definite le/la/les) so a vowel-initial noun's gender stays legible: "une
// eau"/"un homme" rather than "l'eau"/"l'homme", which collapse m/f to "l'".
// Closed set so a hallucinated "le" / "l'" / English "a" is rejected at the
// validation boundary rather than poisoning the cache.
const VALID_ARTICLES: ReadonlySet<string> = new Set(['un', 'une', 'des']);
// French has no neuter — narrow to m/f. A hallucinated 'n' is rejected at the
// validation boundary (the shared EnrichmentGender type still allows 'n').
const VALID_GENDERS: ReadonlySet<EnrichmentGender> = new Set<EnrichmentGender>(['m', 'f']);

const FEW_SHOT: readonly FewShot[] = [
  {
    input: {
      text: 'information',
      translations: ['information'],
      morphology_hint: {
        text: 'information',
        pos: 'noun',
        gender: 'f',
        number: 'singular',
        article: 'une',
        confidence: 'high',
        reason: '-tion/-sion/-xion ending → feminine',
        needsEnrichment: false,
      },
    },
    output: {
      text: 'information',
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      article: 'une',
      lemma: 'information',
      inflection: null,
      notes: null,
    },
  },
  {
    input: {
      text: 'eau',
      translations: ['water'],
      morphology_hint: {
        text: 'eau',
        pos: 'unknown',
        gender: null,
        number: null,
        article: null,
        confidence: 'low',
        reason: 'no morphology rule matched',
        needsEnrichment: true,
      },
    },
    output: {
      text: 'eau',
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      // Indefinite "une" keeps the feminine gender visible; the definite form
      // would elide to "l'eau" and hide it.
      article: 'une',
      lemma: 'eau',
      inflection: null,
      notes: null,
    },
  },
  {
    input: {
      text: 'fini',
      translations: ['finished', 'done'],
      morphology_hint: {
        text: 'fini',
        pos: 'unknown',
        gender: null,
        number: null,
        article: null,
        confidence: 'low',
        reason: 'no morphology rule matched',
        needsEnrichment: true,
      },
    },
    output: {
      text: 'fini',
      pos: 'verb',
      gender: null,
      number: null,
      article: null,
      lemma: 'finir',
      inflection: 'past participle of finir',
      notes: null,
    },
  },
  {
    // Epicene noun: same form for both genders. gender/article take a single
    // value (masculine citation form here); the dual gender lives in notes.
    // Also shows overriding a low-confidence -re verb hint into a noun.
    input: {
      text: 'secrétaire',
      translations: ['secretary'],
      morphology_hint: {
        text: 'secrétaire',
        pos: 'verb',
        gender: null,
        number: null,
        article: null,
        confidence: 'low',
        reason:
          '-er/-ir/-re ending → likely verb infinitive (noun homographs exist — LLM to confirm)',
        needsEnrichment: true,
      },
    },
    output: {
      text: 'secrétaire',
      pos: 'noun',
      gender: 'm',
      number: 'singular',
      article: 'un',
      lemma: 'secrétaire',
      inflection: null,
      notes: 'épicène : un/une secrétaire',
    },
  },
  {
    input: {
      text: 'se garer',
      translations: ['to park', 'park'],
      morphology_hint: {
        text: 'se garer',
        pos: 'phrase',
        gender: null,
        number: null,
        article: null,
        confidence: 'high',
        reason: 'multi-word phrase',
        needsEnrichment: false,
      },
    },
    output: {
      text: 'se garer',
      pos: 'phrase',
      gender: null,
      number: null,
      article: null,
      lemma: 'se garer',
      inflection: null,
      notes: 'reflexive verb: "to park (a vehicle)"',
    },
  },
];

export const fr: LanguageModule = {
  code: 'fr',
  displayName: 'French',
  defaultDeckName: 'Duolingo::French',
  inferMorphology,
  enrichment: {
    systemPrompt: SYSTEM_PROMPT,
    toolDescription: 'Record grammatical metadata for the supplied French lexemes.',
    lemmaDescription:
      'dictionary form. For nouns, the singular. For inflected verbs, the infinitive. For adjectives, the masculine singular. For phrases, the phrase itself.',
    inflectionDescription:
      "brief grammatical note like 'past participle of arriver' or 'feminine plural of petit'",
    articleDescription:
      "indefinite article (un/une/des) — null for non-nouns. Use the indefinite, not the definite, so gender stays visible before vowels ('une eau', not 'l'eau').",
    fewShot: FEW_SHOT,
    validArticles: VALID_ARTICLES,
    validGenders: VALID_GENDERS,
  },
};
