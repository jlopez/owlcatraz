import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Owlcatraz',
  // Pins the extension ID (geinbedeaknecnljpfdpaomlfojcabim) so it no longer
  // depends on the unpacked load path — every install (any path, every CI
  // artifact) shares one ID, so chrome.storage.local (the API key + the LLM
  // enrichment cache) survives across reloads and re-downloads. This is the
  // base64 DER public key of a dev keypair; it's public, hence safe to commit
  // (the private .pem is not needed for unpacked loads and is not in the repo).
  // When we publish to the Chrome Web Store, swap this for the store-assigned
  // public key so the dev build and the published build share an identity.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtIcvyweOtj4qoOuL3u27QsldtWT0Xufo42RDPUJlbABbnWzQPUg0MwM3CfAi1GTOs2YAlB6+y3qonyMGtjAiOueFxW8ni6UilRixZQOiHywoSK1Z2fFCHBB+tmu0dNmiqTeK2ArbAUvJnzMCWsvW42+A+5Z2XcbD7DwChCVgxWkGp/L2eJH1YxHDBijHTSMBGPFsqzmR/MOWuqNTXWGaEShHlsGIr4gs1CLjPm7bzV+RQIUe0TgkYF2SNI264iuUZ4/ZXLr0B0jSxmc2jQiLhH5YpaPfskP4H9HAcLks3mztXbqDSOfi3Eb9Zlhxi8dJ7yrbZuKB1R3mddgX/YyiOwIDAQAB',
  // Version is injected at build time from `derive-version` (see
  // .github/workflows/ci.yml) and never stored in-tree. `version` must be a
  // dotted-integer string, so it gets the clean semver; `version_name` is
  // free-form and display-only — CI stamps releases with the plain semver and
  // preview builds with the richer `git describe` identity (commits-ahead +
  // sha). A local `pnpm build` with no env falls back to a dev sentinel.
  version: process.env.VERSION ?? '0.0.0',
  version_name: process.env.VERSION_NAME ?? 'dev',
  description:
    'Export your Duolingo vocabulary to an Anki deck for personal spaced-repetition study.',
  action: {
    default_popup: 'index.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  // `declarativeNetRequestWithHostAccess` covers the session-scoped rule
  // registered at service-worker startup (see src/background/service-worker.ts)
  // that strips the Origin header on the extension's own fetches to
  // duolingo.com. The rule is registered dynamically rather than via the
  // manifest's `rule_resources` because Chrome MV3 rejects `tabIds` /
  // `excludedTabIds` on static DNR rules — those keys are session-rule-only,
  // and we need `tabIds: [-1]` (TAB_ID_NONE) to scope the rule to
  // service-worker fetches so the user's normal browsing traffic is
  // unaffected.
  permissions: ['storage', 'cookies', 'declarativeNetRequestWithHostAccess'],
  host_permissions: [
    'https://*.duolingo.com/*',
    // Duolingo serves lexeme audio off a single CloudFront distribution. The
    // CDN returns the MP3 publicly but emits no Access-Control-Allow-Origin
    // header, so without an explicit host_permission the browser blocks the
    // extension from reading the response body. Tight subdomain match: if
    // Duolingo rotates distributions the popup's `Audio failed` counter rises
    // (and maybeStoreAudio logs to the service-worker console) — check those
    // after a sync if audio stops working.
    'https://d1vq87e9lcf771.cloudfront.net/*',
    'https://api.anthropic.com/*',
    'http://127.0.0.1:8765/*',
  ],
  // Pre-sized icons at every density Chrome requests, so it never has to
  // downsample at render time. 16/32 are toolbar / extensions-bar sizes;
  // 48 is the extensions-management page; 128 is the Web Store listing.
  icons: {
    16: 'icon-16.png',
    32: 'icon-32.png',
    48: 'icon-48.png',
    128: 'icon-128.png',
  },
});
