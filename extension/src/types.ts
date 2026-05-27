export interface Lexeme {
  text: string;
  translations: string[];
  audioURL: string | null;
  isNew: boolean;
}

export interface Pagination {
  totalLexemes: number;
  requestedPageSize: number;
  pageSize: number;
  previousStartIndex: number | null;
  nextStartIndex: number | null;
}

export interface LexemesPage {
  learnedLexemes: Lexeme[];
  pagination: Pagination;
}

export function isLexeme(value: unknown): value is Lexeme {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['text'] !== 'string') return false;
  if (!Array.isArray(v['translations'])) return false;
  if (!v['translations'].every((t): t is string => typeof t === 'string')) return false;
  if (v['audioURL'] !== null && typeof v['audioURL'] !== 'string') return false;
  if (typeof v['isNew'] !== 'boolean') return false;
  return true;
}

export function isPagination(value: unknown): value is Pagination {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['totalLexemes'] !== 'number') return false;
  if (typeof v['requestedPageSize'] !== 'number') return false;
  if (typeof v['pageSize'] !== 'number') return false;
  if (v['previousStartIndex'] !== null && typeof v['previousStartIndex'] !== 'number') return false;
  if (v['nextStartIndex'] !== null && typeof v['nextStartIndex'] !== 'number') return false;
  return true;
}

export function isLexemesPage(value: unknown): value is LexemesPage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['learnedLexemes'])) return false;
  if (!v['learnedLexemes'].every(isLexeme)) return false;
  if (!isPagination(v['pagination'])) return false;
  return true;
}
