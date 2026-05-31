import type { LanguageModule } from './types';
import { el } from './el';

// Central registry of supported Duolingo course languages. Adding a new
// language is a 3-step change: implement the LanguageModule (morphology +
// enrichment config), register it here, and add fixtures + tests.
export const LANGUAGE_MODULES: Readonly<Record<string, LanguageModule>> = {
  [el.code]: el,
};

export const SUPPORTED_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_MODULES);

export function isSupportedLanguage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_MODULES, code);
}

/** Throws if `code` is not a supported language — call sites that have
 *  already validated against isSupportedLanguage can rely on the throw as
 *  defense-in-depth. */
export function getLanguageModule(code: string): LanguageModule {
  const mod = LANGUAGE_MODULES[code];
  if (mod === undefined) {
    throw new Error(
      `Unsupported language "${code}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}.`,
    );
  }
  return mod;
}

/** The deck name to use for a given language code: the user-customized value
 *  if one is stored under settings.deckNames, otherwise the module's default. */
export function resolveDeckName(deckNames: Record<string, string>, code: string): string {
  const stored = deckNames[code];
  if (typeof stored === 'string' && stored.length > 0) return stored;
  return getLanguageModule(code).defaultDeckName;
}
