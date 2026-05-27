# Contributing to Owlcatraz

Thanks for your interest. Owlcatraz is a small utility maintained in spare
time; contributions are welcome and appreciated.

## Filing issues

Bug reports and feature requests go in
[GitHub Issues](https://github.com/jlopez/owlcatraz/issues). For bug reports,
please use the issue template — Duolingo ships A/B-tested API changes
constantly, and structured reports (course, browser version, extension
version, what broke) are how the project survives.

For open-ended questions, design discussions, or "how do I use this with
language X?", please open a [Discussion](https://github.com/jlopez/owlcatraz/discussions)
instead so the Issues tab stays focused on actionable bugs.

## Submitting pull requests

1. Open or comment on an issue first if the change is non-trivial, so we can
   agree on scope before you spend time on it.
2. Fork the repo, create a feature branch, push your changes.
3. Ensure CI is green locally before opening the PR:
   ```
   cd extension
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint
   pnpm format:check
   pnpm test
   pnpm build
   ```
4. Open the PR against `main`. Describe what changed and why.

## Code style

- TypeScript strict mode (the existing `tsconfig.base.json` settings —
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc. — apply).
- ESLint and Prettier run in CI; `pnpm lint` and `pnpm format:check` must
  pass.
- Comments are sparing: explain *why*, not *what*. The code identifiers
  should do the *what* on their own.
- Tests for new logic. The existing offline fixture suite is the model:
  prefer JSON-shape fixtures over per-call HTTP mocks where possible.

## Out of scope

Some categories of contribution will be declined. Please save your time:

- **PRs that bypass, evade, or interact with Duolingo's paid features**
  (Super, Max, etc.). Owlcatraz only exports vocabulary the logged-in user
  has already earned through normal study.
- **Automation, account farming, or scraping beyond the user's own
  session.** The extension reads the signed-in user's own learned-lexemes
  list and stops there.
- **Telemetry, analytics, or any feature that sends user data to a
  developer-controlled server.** The extension is local-first by design;
  the only outbound network traffic is to Duolingo (the user's own
  session), the Anthropic API (the user's own API key, for grammatical
  enrichment), and a local AnkiConnect endpoint.
- **Aggressive request patterns.** Pagination respects the API's natural
  cursoring; sustained or parallel fan-out against Duolingo's servers is
  not a direction this project will go.

These constraints exist so the project stays a legitimate personal-export
utility — narrow scope, clear purpose, no ambiguity for Duolingo's
engineering or legal teams about what the tool is for. PRs in these
categories will be closed.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
Participation in issues, discussions, and pull requests implies agreement.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](./LICENSE) that covers the project.
