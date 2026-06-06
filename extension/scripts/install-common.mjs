// Shared plumbing for the install:* scripts.
//
// Chrome deliberately blocks programmatic install of non-Web-Store
// extensions, so none of these scripts can reach a "fully installed" state on
// their own. What they DO is shrink the manual gap to its floor: fetch the
// right bytes, unpack them to one *stable* path, and hand off to Chrome with
// copy-paste-ready guidance. The stable path is the trick — first install is a
// one-time Load-unpacked; every later run overwrites the same folder in place,
// so updating is a single reload click (no re-picking a folder).
//
// macOS is the first-class target (open / pbcopy niceties). On other platforms
// the scripts still work; they just print the path instead of opening Chrome
// and copying to the clipboard.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();

/** Repo root of the extension (scripts/ lives directly under it). */
export const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Everything we own lives under here so it's trivial to find or wipe. */
export const OWL_DIR = join(HOME, '.owlcatraz');

/** The one stable load path. All three scripts populate THIS directory. */
export const STABLE_DIR = join(OWL_DIR, 'unpacked');

/** Marker recording that we've already walked the user through first load. */
const LOADED_MARKER = join(OWL_DIR, '.loaded');

const isMac = process.platform === 'darwin';

// ── tiny console helpers ────────────────────────────────────────────────────

export const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
export const info = (msg) => console.log(`  ${msg}`);
export const step = (msg) => console.log(msg);

export function fail(msg) {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
  process.exit(1);
}

// ── command helpers ─────────────────────────────────────────────────────────

/** Run a command, inheriting stdio (for build output etc.). Throws on failure. */
export function run(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: 'inherit', ...opts });
}

/** Block for `seconds` (synchronous; shells out to the system `sleep`). Used to
 *  poll for a CI run to register without pulling in async plumbing. */
export function sleep(seconds) {
  execFileSync('sleep', [String(seconds)]);
}

/** Run a command and capture trimmed stdout. Throws on failure; the command's
 *  own stderr is captured into the error (not leaked) so callers can present a
 *  single friendly message instead of the tool's raw diagnostic. */
export function capture(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

// ── preflight ───────────────────────────────────────────────────────────────

/** Ensure the GitHub CLI is present and authenticated (release/PR downloads). */
export function ensureGh() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('GitHub CLI not found. Install it (macOS: `brew install gh`) and re-run.');
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    fail('GitHub CLI is not authenticated. Run `gh auth login` and re-run.');
  }
}

// ── filesystem ──────────────────────────────────────────────────────────────

/** Empty (or create) the stable load directory so we populate it cleanly. */
export function resetStableDir() {
  rmSync(STABLE_DIR, { recursive: true, force: true });
  mkdirSync(STABLE_DIR, { recursive: true });
}

/** Make a fresh temp working dir under OWL_DIR (no Date/random needed). */
export function freshTmp(label) {
  const dir = join(OWL_DIR, `.tmp-${label}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Unzip `zipPath` into `dest` (must already exist). Requires the `unzip` CLI. */
export function unzipInto(zipPath, dest) {
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest], { stdio: 'inherit' });
}

/** First *.zip found anywhere under `root` (depth-first), or null. */
export function findZip(root) {
  const hit = readdirSync(root, { recursive: true, withFileTypes: true }).find(
    (e) => e.isFile() && e.name.endsWith('.zip'),
  );
  return hit ? join(hit.parentPath ?? hit.path, hit.name) : null;
}

// ── hand-off to Chrome ──────────────────────────────────────────────────────

function openInChrome(url) {
  if (!isMac) return false;
  try {
    execFileSync('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function copyToClipboard(text) {
  if (!isMac) return false;
  try {
    execSync('pbcopy', { input: text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Final step shared by all three scripts: open chrome://extensions and print
 * the minimal manual steps. First run shows the one-time Load-unpacked flow;
 * later runs show the single reload click.
 */
export function handOff({ sourceLabel }) {
  const firstTime = !existsSync(LOADED_MARKER);
  const opened = openInChrome('chrome://extensions');
  const copied = copyToClipboard(STABLE_DIR);

  console.log('');
  ok(`${sourceLabel} ready in ${STABLE_DIR}`);
  if (copied) info('(path copied to your clipboard)');
  console.log('');

  if (firstTime) {
    step('First-time setup — once per machine:');
    info(`${opened ? 'chrome://extensions just opened.' : 'Open chrome://extensions in Chrome.'}`);
    info('1. Toggle "Developer mode" (top-right).');
    info('2. Click "Load unpacked".');
    if (isMac) info('3. Press ⌘⇧G, paste the path, Enter, then "Select".');
    else info(`3. Select the folder: ${STABLE_DIR}`);
    console.log('');
    info('Use a Chrome window that is signed in to Duolingo — the extension');
    info('reads your own Duolingo session from that profile.');
    mkdirSync(OWL_DIR, { recursive: true });
    writeFileSync(LOADED_MARKER, 'loaded\n');
  } else {
    step('Already loaded once — just refresh:');
    info(opened ? 'chrome://extensions just opened.' : 'Open chrome://extensions in Chrome.');
    info('Click the ↻ reload icon on the Owlcatraz card to pick up this build.');
  }
  console.log('');
}
