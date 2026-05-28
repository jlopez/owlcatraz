import type { Lexeme } from '../types';

export type POS = 'noun' | 'verb' | 'adjective' | 'phrase' | 'unknown';
export type Gender = 'm' | 'f' | 'n';
export type GrammaticalNumber = 'singular' | 'plural';
export type Confidence = 'high' | 'medium' | 'low';

export interface MorphologyResult {
  text: string;
  pos: POS;
  gender: Gender | null;
  number: GrammaticalNumber | null;
  article: string | null;
  confidence: Confidence;
  reason: string;
  needsEnrichment: boolean;
}

function endsWithAny(text: string, suffixes: readonly string[]): boolean {
  for (const s of suffixes) {
    if (text.endsWith(s)) return true;
  }
  return false;
}

export function inferMorphology(lexeme: Lexeme): MorphologyResult {
  // Trim defensively. `isLexeme` in src/types.ts is the source-of-truth
  // validator and won't return whitespace-wrapped text in practice, but a
  // wrapped input would silently match rule 1 (phrase) with confidence=high
  // — confidently wrong and not flagged for the LLM. Cheaper to normalize.
  const text = lexeme.text.trim();

  // Rule 1: phrase (contains internal whitespace)
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

  // Rule 2: -μα neuter (high), length > 3 to exclude "μα"
  if (text.length > 3 && text.endsWith('μα')) {
    return {
      text,
      pos: 'noun',
      gender: 'n',
      number: 'singular',
      article: 'το',
      confidence: 'high',
      reason: '-μα ending → neuter',
      needsEnrichment: false,
    };
  }

  // Rule 3: -ί / -ι neuter (high), length > 2, but NOT -οι/-ει/-αι.
  // - -οι: masculine plural (σκύλοι, φίλοι, κύριοι).
  // - -ει: 3sg present indicative for many verbs (παίζει, γράφει, τρώει).
  // - -αι: είναι (and rare nouns like τσάι — false-negative is fine, LLM
  //   classifies correctly via rule 10).
  // Without these exclusions the synthesizer short-circuits to "neuter
  // singular, article=το" and the note is wrong on every axis (verified
  // empirically with σκύλοι → "το σκύλοι", είναι → "το είναι").
  if (text.length > 2 && endsWithAny(text, ['ί', 'ι']) && !endsWithAny(text, ['οι', 'ει', 'αι'])) {
    return {
      text,
      pos: 'noun',
      gender: 'n',
      number: 'singular',
      article: 'το',
      confidence: 'high',
      reason: '-ι ending → neuter',
      needsEnrichment: false,
    };
  }

  // Rule 4: -ας / -άς / -ής / -ης masculine (medium), length > 3.
  // -άς accepted as the accented parallel of -ας (μπαμπάς). This will also
  // catch 2nd-person verb forms like μιλάς — accepted trade-off; phase-4 LLM
  // will reclassify (`reason` discloses the rule for downstream override).
  // -ές and -ούς deliberately NOT added: -ές collides heavily with 2nd-person
  // verb endings (έχεις, είστε-family) without a clean fallback.
  if (text.length > 3 && endsWithAny(text, ['ας', 'άς', 'ής', 'ης'])) {
    return {
      text,
      pos: 'noun',
      gender: 'm',
      number: 'singular',
      article: 'ο',
      confidence: 'medium',
      reason: '-ας/-ης ending → masculine',
      needsEnrichment: false,
    };
  }

  // Rule 5: -ός / -ος masculine (LOW), length > 3 — feminine/neuter exceptions exist
  if (text.length > 3 && endsWithAny(text, ['ός', 'ος'])) {
    return {
      text,
      pos: 'noun',
      gender: 'm',
      number: 'singular',
      article: 'ο',
      confidence: 'low',
      reason: '-ος ending → usually masculine, exceptions exist (η οδός, το λάθος)',
      needsEnrichment: true,
    };
  }

  // Rule 6: -ώ / -ω verb (medium), length > 2 — could be a pronoun like εγώ
  if (text.length > 2 && endsWithAny(text, ['ώ', 'ω'])) {
    return {
      text,
      pos: 'verb',
      gender: null,
      number: null,
      article: null,
      confidence: 'medium',
      reason:
        '-ω ending → likely verb 1st-person singular (could be pronoun like εγώ — LLM to confirm)',
      needsEnrichment: true,
    };
  }

  // Rule 7: -η / -ή feminine (medium), length > 2.
  // -ή accepted as the accented parallel of -η (αδελφή, αμερική). Will also
  // mistag a few adjective/pronoun forms (δική, αυτή); phase-4 LLM corrects.
  if (text.length > 2 && endsWithAny(text, ['η', 'ή'])) {
    return {
      text,
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      article: 'η',
      confidence: 'medium',
      reason: '-η ending → feminine',
      needsEnrichment: false,
    };
  }

  // Rule 8: -α feminine (medium), length > 2 — but -μα was handled by rule 2.
  // Overlaps with neuter plurals (-α from singular -ο/-ί); not disambiguated here.
  if (text.length > 2 && text.endsWith('α')) {
    return {
      text,
      pos: 'noun',
      gender: 'f',
      number: 'singular',
      article: 'η',
      confidence: 'medium',
      reason:
        '-α ending → feminine (note: overlaps with neuter plural form, not disambiguated here)',
      needsEnrichment: false,
    };
  }

  // Rule 9: -ό / -ο neuter (medium), length > 2
  if (text.length > 2 && endsWithAny(text, ['ό', 'ο'])) {
    return {
      text,
      pos: 'noun',
      gender: 'n',
      number: 'singular',
      article: 'το',
      confidence: 'medium',
      reason: '-ο ending → neuter',
      needsEnrichment: false,
    };
  }

  // Rule 10: default
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
