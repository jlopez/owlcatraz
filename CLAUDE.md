# CLAUDE.md

Project-specific guidance for AI agents working on Owlcatraz. The README is
the user-facing entry point; this file documents constraints and conventions
that aren't obvious from reading the code.

## What this project is

A Chrome MV3 extension that exports a user's own Duolingo vocabulary into
an Anki deck. Runs locally in the user's browser, talks to Duolingo with
the user's own session cookie, calls the Anthropic API with the user's own
key for grammatical enrichment, and writes notes to a local Anki instance
via AnkiConnect on `127.0.0.1:8765`.

**Currently supports the Greek course only.** The data and sync layers are
language-agnostic; morphology (`src/lib/morphology.ts`) and enrichment
(`src/lib/enrich.ts`) are Greek-shaped. The popup hardcodes
`LANGUAGE = 'el'` and refuses to sync against any other course. Don't
remove the Greek language framing from docs — additional courses are on
the roadmap but aren't implemented.

## Hard rules — read before you touch fixtures or docs

### Fixtures must be 100% synthesized

`fixtures/*.json` should not contain real data. This is non-negotiable
for IP and PII reasons:

If you need different/larger fixtures: extend by writing more synthesized
entries by hand.

If you change fixture size or composition, expect to update:
- `tests/fixtures.test.ts` (asserted length, pagination metadata)
- `tests/duolingo.test.ts` (page-name map, expected pagination call count)
- `tests/morphology.test.ts` (phrase count exact, coverage floors)

### Scope discipline — refuse these contributions

The project's narrow scope is its own legal defense. Refuse PRs (and don't
write code) that:

- Bypass any Duolingo paid feature (Super, Max, Family, etc.).
- Scrape data beyond the signed-in user's own learned-lexemes list.
- Add telemetry, analytics, or any developer-controlled outbound endpoint.
- Implement aggressive request patterns (concurrent fan-out, retry storms,
  bypassing rate limits).

`CONTRIBUTING.md` documents these on the public record. The README has a
parallel "What it does not do" list. Keep both honest.

### Documentation tone

Factual, friendly, not snarky. The project name (Owlcatraz, an Alcatraz
parody) carries all the humor the docs need — the documentation itself is
straightforward and adult. Avoid any Duolingo IP branding assets (logo,
character, signature green).

## Architecture

```
extension/src/
  background/service-worker.ts   Chrome MV3 entry; registers DNR session rule;
                                 dispatches getStatus + startSync messages
  popup/main.ts + Popup.ts       UI; hardcodes LANGUAGE = 'el'
  lib/duolingo.ts                JWT decode, cookie read, profile + lexeme fetch
  lib/morphology.ts              Greek-specific rule-based POS/gender tagger
  lib/enrich.ts                  Anthropic API enrichment + chrome.storage cache
  lib/anki.ts                    AnkiConnect: ensureDeck, ensureNoteType, syncToAnki
  lib/sync.ts                    Orchestrates the full pipeline; emits progress
  lib/settings.ts                API key, deck name, skipAudio persistence
  lib/messages.ts                Type-only: popup ↔ service-worker message shapes
  types.ts                       Lexeme, LexemesPage, type guards
```

## Daily workflow

### Commands (run from `extension/`)

| Command             | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `pnpm dev`          | Vite build in watch mode (load unpacked from `dist/`)  |
| `pnpm build`        | Production build to `dist/`                            |
| `pnpm test`         | Run vitest once (no coverage gate)                     |
| `pnpm test:watch`   | Watch-mode vitest                                      |
| `pnpm coverage`     | vitest + v8 coverage + threshold gate (used in CI)     |
| `pnpm typecheck`    | `tsc -b` strict typecheck                              |
| `pnpm lint`         | ESLint (flat config), fails on any warning             |
| `pnpm format`       | Prettier write                                         |
| `pnpm format:check` | Prettier check (used in CI)                            |

### CI gates (all must pass)

The `.github/workflows/ci.yml` `check` job runs, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm format:check`
5. `pnpm coverage` — enforces thresholds defined in `extension/vitest.config.ts`
6. `pnpm build`

Coverage thresholds:

- Global: 85% statements / 75% branches / 90% functions / 85% lines
- `src/lib/**`: 90% / 80% / 95% / 90% — tighter because logic regressions matter
- Excluded from coverage: `src/background/**` (Chrome-only, untestable in vitest), `src/popup/main.ts` (3-line entry), `src/lib/messages.ts` (type-only)

Don't drop a threshold to make a PR green. Add tests, or — if the
regression is in legitimately untestable boundary code — discuss with the
user whether the file should join the exclusion list.

### Git convention

Changes go through PRs with **squash merge only** (merge commits and rebase
merges are disabled in repo settings). Auto-delete head branches on merge
is enabled.

## Testing

The offline 140-test suite at `tests/` covers data validation, morphology,
enrichment, Anki write, and sync orchestration. The popup-smoke test
exercises the `deriveViewFromStatus` state machine against happy-dom.

The live Duolingo API, the Anthropic API, and AnkiConnect integrations
can only be verified by hand against a real Chrome profile, a real
Anthropic key, and a running Anki + AnkiConnect. The README's "End-to-end
smoke test" section is the canonical procedure.

When adding new test code:

- Test against fixture JSON (extend the existing fixtures if needed); don't
  mock individual HTTP calls if a fixture-driven test is feasible.
- Add new fixtures as files in `fixtures/`, not inline strings in tests,
  unless the data is single-use and very small.

## Things that look like they need fixing but don't

- The default deck name `Duolingo::Greek` (in `src/lib/settings.ts`) is
  intentional. The deck name describes the *source* of the vocabulary —
  what's inside the deck — not the tool that produced it. Don't rebrand
  it to `Owlcatraz::Greek`.
- `manifest.config.ts` hardcodes the specific CloudFront subdomain
  (`d1vq87e9lcf771.cloudfront.net`) in `host_permissions`. This is
  load-bearing: `host_permissions` doesn't support wildcards across
  the `cloudfront.net` parent (security model), so the exact subdomain
  has to be listed. The README describes it generically as
  `*.cloudfront.net` and points readers at the manifest for the precise
  pin.
- Coverage on `src/popup/Popup.ts` is ~54% and excluded files (service
  worker, popup main entry, messages type module) are at 0%. This is
  intentional: those paths require a real Chrome runtime to exercise.
- The `extractProgressedSkills` function always returns
  `finishedLevels: 99, finishedSessions: 99` regardless of input. This
  is correct — Duolingo's API ignores the numeric values; only the
  skill IDs are load-bearing. The comment in `duolingo.ts` documents
  the 2026-05-20 empirical verification.
