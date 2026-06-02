import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isLexeme, isLexemesPage, type Lexeme, type LexemesPage } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../fixtures');

function loadJSON(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

describe('all-lexemes.json fixture', () => {
  const raw = loadJSON('all-lexemes.json');

  it('is an array of 50 lexemes', () => {
    expect(Array.isArray(raw)).toBe(true);
    expect((raw as unknown[]).length).toBe(50);
  });

  it('every entry conforms to the Lexeme type guard', () => {
    const arr = raw as unknown[];
    const invalid = arr.filter((x) => !isLexeme(x));
    expect(invalid).toEqual([]);
  });

  it('every entry contains at least one Greek-script character (UTF-8 sanity check)', () => {
    const arr = raw as Lexeme[];
    const greekScript = /[Ͱ-Ͽἀ-῿]/;
    const offenders = arr.filter((l) => !greekScript.test(l.text));
    expect(offenders).toEqual([]);
  });

  it('contains at least one entry with null audioURL', () => {
    const arr = raw as Lexeme[];
    expect(arr.some((l) => l.audioURL === null)).toBe(true);
  });
});

describe('page-0.json fixture', () => {
  const raw = loadJSON('page-0.json');

  it('parses as a LexemesPage', () => {
    expect(isLexemesPage(raw)).toBe(true);
  });

  it('has the expected pagination metadata', () => {
    const page = raw as LexemesPage;
    expect(page.pagination.totalLexemes).toBe(50);
    expect(page.pagination.nextStartIndex).toBe(50);
  });
});

function loadFrJSON(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, 'fr', name), 'utf8'));
}

describe('fr/all-lexemes.json fixture', () => {
  const raw = loadFrJSON('all-lexemes.json');

  it('is an array of 50 lexemes', () => {
    expect(Array.isArray(raw)).toBe(true);
    expect((raw as unknown[]).length).toBe(50);
  });

  it('every entry conforms to the Lexeme type guard', () => {
    const arr = raw as unknown[];
    const invalid = arr.filter((x) => !isLexeme(x));
    expect(invalid).toEqual([]);
  });

  it('every entry is Latin script with no stray Greek characters', () => {
    const arr = raw as Lexeme[];
    const greekScript = /[Ͱ-Ͽἀ-῿]/;
    const latin = /[A-Za-zÀ-ÿ]/;
    const offenders = arr.filter((l) => greekScript.test(l.text) || !latin.test(l.text));
    expect(offenders).toEqual([]);
  });

  it('exercises French diacritics (at least one accented entry)', () => {
    const arr = raw as Lexeme[];
    const accented = /[àâäéèêëîïôöùûüçœæ]/i;
    expect(arr.some((l) => accented.test(l.text))).toBe(true);
  });

  it('contains at least one entry with null audioURL', () => {
    const arr = raw as Lexeme[];
    expect(arr.some((l) => l.audioURL === null)).toBe(true);
  });

  it('uses only synthetic CloudFront audio URLs (no real Duolingo hashes)', () => {
    const arr = raw as Lexeme[];
    const offenders = arr.filter(
      (l) =>
        l.audioURL !== null &&
        !l.audioURL.startsWith('https://d1vq87e9lcf771.cloudfront.net/beafr/synth-'),
    );
    expect(offenders).toEqual([]);
  });
});

describe('fr/page-0.json fixture', () => {
  const raw = loadFrJSON('page-0.json');

  it('parses as a LexemesPage', () => {
    expect(isLexemesPage(raw)).toBe(true);
  });

  it('is a single page covering all 50 lexemes (nextStartIndex null)', () => {
    const page = raw as LexemesPage;
    expect(page.learnedLexemes).toHaveLength(50);
    expect(page.pagination.totalLexemes).toBe(50);
    expect(page.pagination.nextStartIndex).toBeNull();
  });
});
