// `pnpm install:latest` — download the newest GitHub Release zip and load it.
//
// `gh release download` with no tag resolves to the latest release; the repo is
// inferred from the git remote of the current directory, so there's nothing to
// hardcode. The release asset is the extension zip directly (not double-wrapped
// the way Actions artifacts are), so it's a single unzip into the stable dir.

import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  ensureGh,
  fail,
  findZip,
  freshTmp,
  handOff,
  ok,
  publishStable,
  run,
  unzipInto,
} from './install-common.mjs';

ensureGh();

const tmp = freshTmp('release');

try {
  run('gh', ['release', 'download', '--pattern', 'owlcatraz-*.zip', '--dir', tmp, '--clobber']);
} catch {
  fail('No matching release asset found. Has a release been published yet? See the Releases page.');
}

const zip = findZip(tmp);
if (!zip) fail('Release downloaded but no owlcatraz-*.zip was inside it.');
ok(`Downloaded ${basename(zip)}`);

// Unpack into a staging dir, then atomically swap into the load dir, so a bad
// unzip can't wipe a working install.
const staged = join(tmp, 'staged');
unzipInto(zip, staged);
publishStable(staged);
rmSync(tmp, { recursive: true, force: true });

handOff({ sourceLabel: 'Latest release' });
