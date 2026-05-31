import type { Lexeme } from '../../types';

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

export type EnrichmentPOS =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'pronoun'
  | 'article'
  | 'phrase'
  | 'particle'
  | 'other';

export type EnrichmentGender = 'm' | 'f' | 'n';
export type EnrichmentNumber = 'singular' | 'plural';

export interface EnrichmentInput {
  lexeme: Lexeme;
  morphology: MorphologyResult;
}

export interface Enrichment {
  text: string;
  pos: EnrichmentPOS;
  gender: EnrichmentGender | null;
  number: EnrichmentNumber | null;
  article: string | null;
  lemma: string;
  inflection: string | null;
  notes: string | null;
}

export interface FewShot {
  // morphology_hint mirrors the full MorphologyResult shape used on the wire
  // — keeping examples and real inputs structurally identical helps the model
  // learn the schema rather than getting confused by partial hints.
  input: { text: string; translations: string[]; morphology_hint: MorphologyResult };
  output: Enrichment;
}

export interface EnrichmentConfig {
  // Sent as the Anthropic `system` parameter. Should establish the linguistic
  // role and lemma/article/gender conventions for this language.
  systemPrompt: string;
  // Tool description shown in the tool definition, e.g. "Record grammatical
  // metadata for the supplied <Language> lexemes."
  toolDescription: string;
  // Per-language guidance baked into the schema for the `lemma`,
  // `inflection`, and `article` fields — what the model should produce for
  // that language's dictionary form, inflection notation, and article
  // conventions (Greek needs "nominative"; French has no nominative).
  lemmaDescription: string;
  inflectionDescription: string;
  articleDescription: string;
  fewShot: readonly FewShot[];
  // Articles allowed in the `article` field of an Enrichment. Used as the
  // schema enum and as a runtime validator that rejects out-of-set values.
  validArticles: ReadonlySet<string>;
  // Genders allowed in the `gender` field. Greek allows all three (m/f/n);
  // French will narrow to (m/f).
  validGenders: ReadonlySet<EnrichmentGender>;
}

export interface LanguageModule {
  // Duolingo course code, e.g. 'el' (Greek), 'fr' (French).
  code: string;
  // Human-readable name shown in popup copy, e.g. 'Greek'.
  displayName: string;
  // Default Anki deck path used when no override is stored under
  // settings.deckNames[code].
  defaultDeckName: string;
  inferMorphology: (lexeme: Lexeme) => MorphologyResult;
  enrichment: EnrichmentConfig;
}
