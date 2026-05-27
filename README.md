# Owlcatraz

[![CI](https://github.com/jlopez/owlcatraz/actions/workflows/ci.yml/badge.svg)](https://github.com/jlopez/owlcatraz/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Owlcatraz — export your Duolingo vocabulary to an Anki deck.**

## What it does

Owlcatraz is a Chrome (MV3) extension that reads your own learned-vocabulary
list from your logged-in Duolingo session and writes it as notes into a
local [Anki](https://apps.ankiweb.net/) deck via the
[AnkiConnect](https://github.com/FooSoft/anki-connect) add-on. The whole
flow runs in your browser: Duolingo fetch, grammatical enrichment (via the
Anthropic API using your own key), and the AnkiConnect write. The data
and sync layers are language-agnostic; the morphology and enrichment
layers are course-specific, and the first release supports the **Greek
course** only. Additional courses are on the roadmap.

## What it does not do

- It does **not** bypass Duolingo paid features (Super, Max, Family, etc.).
  It only reads vocabulary you have already earned through normal study.
- It does **not** scrape or read other users' data. Only the signed-in
  user's own learned-lexemes list is read.
- It does **not** store, transmit, or sell any user data to any
  developer-controlled server. There is no Owlcatraz backend.
- It does **not** run automated mass requests against Duolingo's servers.
  It walks the user's paginated lexeme list once per sync, using the same
  endpoints the Duolingo website itself uses.
- It does **not** modify Duolingo's site behavior beyond initiating the
  export on the user's request.
- It does **not** give you a free Duolingo Super subscription, unlock
  premium features, or interact with billing in any way. (Worth saying
  explicitly — please don't ask.)

## Why this exists

I'm a Duolingo user who also uses Anki. I wanted my vocabulary in both
places — Duolingo for daily practice, Anki for spaced-repetition review
on my own schedule. This tool does that for me, and now for anyone else
who wants the same. The two services are complementary, not competing.

## Installation and usage

The extension is being prepared for the Chrome Web Store. Until it ships
there, you can load it from source:

1. Clone the repo: `git clone https://github.com/jlopez/owlcatraz.git`
2. Build it:
   ```
   cd owlcatraz/extension
   pnpm install
   pnpm build
   ```
3. Open `chrome://extensions` in Chrome, toggle **Developer mode** on
   (top-right).
4. Click **Load unpacked** and select `owlcatraz/extension/dist/`.
5. The Owlcatraz toolbar icon appears. Click it on any tab where you are
   logged in to duolingo.com.
6. Open **Settings**, paste your Anthropic API key (used for grammatical
   enrichment — gender, part-of-speech, inflection notes), optionally
   adjust the Anki deck name, and **Save**.
7. Start [Anki](https://apps.ankiweb.net/) with the
   [AnkiConnect](https://github.com/FooSoft/anki-connect) add-on installed.
8. Click **Sync to Anki**. The popup streams progress through the steps:
   read Duolingo session → fetch lexemes → enrich → write notes.

Re-running **Sync to Anki** is safe — duplicate notes are detected via a
preflight pass and skipped without re-fetching audio.

## Privacy

Owlcatraz is local-first. There is no Owlcatraz server, no analytics,
no telemetry, and no developer-controlled endpoint that ever receives
your data.

The extension makes outbound network requests only to:

- **`*.duolingo.com`** — to fetch your own profile and learned-lexemes
  list, using the Duolingo session cookie that's already in your browser.
  Same data the website shows you, fetched the same way.
- **Duolingo's audio CDN (`*.cloudfront.net`)** — to download the
  pronunciation audio served for each lexeme so it can be embedded in
  the Anki note. The exact subdomain is pinned in the manifest's
  `host_permissions` and lives in [`extension/manifest.config.ts`](./extension/manifest.config.ts);
  URLs come directly from the Duolingo API response.
- **`api.anthropic.com`** — to call Claude Haiku for grammatical
  enrichment (gender, inflection notes, English glosses). This uses
  *your* Anthropic API key, which you provide in the extension's
  Settings panel; calls are billed to your Anthropic account and the
  prompt/response data is governed by
  [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
  If you would rather not send your vocabulary to Anthropic, simply
  don't configure the key — the extension will refuse to sync until a
  key is present.
- **`127.0.0.1:8765`** — your local Anki + AnkiConnect endpoint, on
  loopback. Nothing leaves your machine.

The Anthropic API key, Anki deck name, and enrichment cache are stored
in `chrome.storage.local` — i.e. on your local Chrome profile. They are
not synced to your Google account.

If you ever want to verify any of this, the relevant code is in
[`extension/src/lib/`](./extension/src/lib/) and the manifest permissions
are documented inline in
[`extension/manifest.config.ts`](./extension/manifest.config.ts).

## Relationship to Duolingo

This project is **not affiliated with, endorsed by, or sponsored by
Duolingo, Inc.** "Duolingo" and the Duolingo owl are trademarks of
Duolingo, Inc. The name *Owlcatraz* is an affectionate parody reference
and does not imply any official relationship. The extension does not
include any Duolingo logos, the owl character, or other Duolingo
branding assets.

Owlcatraz uses the same authenticated session your browser already uses
to talk to Duolingo's API on your behalf, walking the same lexeme-list
endpoints the duolingo.com website uses to display your vocabulary.

If you are at Duolingo and have concerns about this project — whether
about scope, traffic patterns, naming, or anything else — please reach
out at **owlcatraz@jesusla.com**. I'd much rather hear from you directly
than have anyone guess at intent. The project's documented scope
(personal vocabulary export, narrowly construed) is the project's actual
scope; the [CONTRIBUTING.md](./CONTRIBUTING.md) file documents the
out-of-scope categories that will be declined.

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](./CONTRIBUTING.md) first — it covers how to file good
bug reports (Duolingo ships A/B-tested API changes constantly, so
structured reports help a lot) and what categories of contribution are
out of scope.

Bug reports go in [Issues](https://github.com/jlopez/owlcatraz/issues);
open-ended questions and design conversations go in
[Discussions](https://github.com/jlopez/owlcatraz/discussions).

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

## Security

To report a security vulnerability, please follow
[SECURITY.md](./SECURITY.md) rather than opening a public issue.

## License

[MIT](./LICENSE) © 2026 Jesus Lopez.

---

## Developer notes

The remainder of this file is for contributors and curious readers. End
users don't need any of it.

### Project layout

- [`extension/`](./extension/) — the Vite + TypeScript MV3 extension.
- [`fixtures/`](./fixtures/) — synthesized lexeme pages and a minimal
  profile (~50 basic Greek words drawn from general public-domain
  vocabulary) used to drive the 140-test offline suite.
- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — typecheck,
  lint, format-check, test, and build on every PR and on push to `main`.

### Commands (run from `extension/`)

| Command             | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `pnpm dev`          | Vite build in watch mode (load unpacked from `dist/`) |
| `pnpm build`        | Production build to `dist/`                           |
| `pnpm test`         | Run vitest once                                       |
| `pnpm test:watch`   | Watch-mode vitest                                     |
| `pnpm typecheck`    | `tsc --noEmit` strict typecheck                       |
| `pnpm lint`         | ESLint (flat config) — fails on any warning           |
| `pnpm format`       | Prettier write                                        |
| `pnpm format:check` | Prettier check (used by CI)                           |

### End-to-end smoke test

The 140-test offline suite (`pnpm test`) covers the data, morphology,
enrichment, sync orchestration, and popup-render layers. The live
Duolingo API and AnkiConnect interactions can only be exercised against
a real Chrome profile and a running Anki + AnkiConnect. The current
release only supports the Greek course, so the smoke test below assumes
Greek is your active Duolingo course. Smoke-test steps:

1. `cd extension && pnpm build`.
2. Open `chrome://extensions` in a Chrome window where you are signed in
   to Duolingo. Toggle **Developer mode** on.
3. Click **Load unpacked** and select `extension/dist/`. The Owlcatraz
   action icon appears in the toolbar.
4. Click the **Service worker** link on the extension card. The DevTools
   console should be empty on a fresh load.
5. Logged-out check: open an Incognito window (with extensions enabled)
   and click the icon. Should say "Please log in at duolingo.com".
6. Confirm Greek is the active Duolingo course on duolingo.com.
7. Click the icon. The popup should show your userId and "course `el`".
8. Open **Settings**, paste your Anthropic API key (`sk-ant-…`),
   optionally adjust the deck name (default `Duolingo::Greek`), Save.
9. Reopen the popup — the API key should round-trip back.
10. Start Anki with the AnkiConnect add-on enabled.
11. Click **Sync to Anki**. Progress should stream through five steps
    (session read → profile lookup → lexeme fetch → enrichment →
    AnkiConnect write).
12. On completion, the stats table reports words fetched, enriched,
    added, skipped, audio stored, audio failed. In Anki, the deck
    contains notes with English, Target, Lemma, POS, Inflection, Notes,
    Audio populated; audio plays on the Recognition back side.
13. Click **Sync again**. Second run reports everything as duplicates
    and finishes in seconds (the preflight skips re-fetching audio for
    known notes).

If anything misbehaves, check the service-worker console (it captures
`syncError` text plus any per-URL audio-fetch warnings) and verify the
Anthropic API key.

### Roadmap

In rough priority order:

- **Update-in-place re-sync.** Today a re-sync either adds new notes or
  skips existing ones. An `updateExisting` path using AnkiConnect's
  `updateNoteFields` would let the enrichment algorithm evolve without
  throwing away the user's review history (cards and scheduling state
  live separately from fields). Pair with a "clear enrichment cache"
  toggle for when the LLM prompt itself changes.
- **Enrichment-algorithm bug fixes.** A handful of known issues to track
  and address in the same pass as update-in-place.
- **Sync progress bar.** The popup currently streams text-only progress
  lines; a visual bar against per-step totals would be a cheap UX win
  for the enrichment and AnkiConnect-write steps (which have known
  totals up front).
- **Incremental sync.** A "since last sync" mode would save the Duolingo
  walk on daily-driver re-syncs. Lower priority because the LLM cost
  is already amortized by the cache and Duolingo's pagination is fast.
- **Regression tests for live-only paths.** Three code paths are only
  exercised end-to-end against a live runtime: the Origin-stripping
  DNR session rule, the AnkiConnect rollback-on-duplicate response
  shape, and the LLM-omission re-queue logic. Each is a likely
  candidate for silent breakage and worth a targeted boundary test.
- **Generalize beyond Greek.** Morphology and the LLM prompts are
  Greek-shaped; adding Spanish or French would surface where the
  Greek-specific assumptions actually live. Largest scope; defer until
  the deck is stable for daily use.
