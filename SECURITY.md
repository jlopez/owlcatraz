# Security Policy

## Supported versions

Owlcatraz follows a rolling-release model — only the latest published
version is supported. If you find a security issue in an older version,
please first verify it still reproduces against the current `main` branch.

## What counts as a security issue

The kinds of things this policy covers:

- The extension exfiltrating data the user did not consent to send (e.g.
  leaking the Anthropic API key, JWT cookie, or vocabulary list to a
  third party).
- Excessive permissions in the manifest (capabilities granted that the
  extension does not need to function).
- Cross-site-scripting or HTML-injection vulnerabilities in the popup UI
  via untrusted Duolingo, Anthropic, or AnkiConnect response payloads.
- Vulnerabilities in build-time or runtime dependencies that affect
  end-users of the extension.

If you are unsure whether something qualifies, err on the side of
reporting it.

## How to report

Email **owlcatraz@jesusla.com** with:

- A description of the issue and its impact.
- Steps to reproduce, ideally against a fresh `pnpm install` of the
  current `main` branch.
- Your assessment of severity.
- Whether you want public credit for the report.

Please **do not** open a public GitHub issue for security vulnerabilities
until they have been addressed.

## Response commitment

You can expect:

- An acknowledgement within **7 days** of your report.
- A status update at least every **14 days** until the issue is resolved
  or closed.
- A coordinated disclosure timeline if the issue warrants it — typically
  fix released first, public write-up after.

This is a personal project maintained in spare time, so the timeline is
best-effort rather than contractual; in practice most issues will be
acknowledged and triaged within a day or two.

## Out of scope

- Reports that the extension reads Duolingo data: that's its documented
  purpose, using the signed-in user's own session.
- Reports that the extension calls the Anthropic API: that's its
  documented purpose, using the user-supplied API key.
- Reports that AnkiConnect runs on `127.0.0.1:8765` without
  authentication: that's an AnkiConnect property, not an Owlcatraz one.
  Please report AnkiConnect-side concerns to the
  [AnkiConnect project](https://github.com/FooSoft/anki-connect)
  directly.
