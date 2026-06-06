// `pnpm install:local` — build from the working tree and load that.
//
// No network, no gh: just `pnpm build` and copy dist/ into the stable dir. We
// keep sourcemaps here (unlike the CD zip, which strips them) — for a local
// build you're more likely to want to debug than to minimise size.

import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { EXT_ROOT, fail, freshTmp, handOff, ok, publishStable, run } from './install-common.mjs';

run('pnpm', ['build'], { cwd: EXT_ROOT });

const dist = join(EXT_ROOT, 'dist');
if (!existsSync(dist)) fail('Build finished but dist/ is missing — check the build output above.');

// Stage a copy of dist (leaving the build output in place), then atomically
// swap it into the load dir.
const staged = freshTmp('local');
cpSync(dist, staged, { recursive: true });
publishStable(staged);
ok('Built and staged the local extension');

handOff({ sourceLabel: 'Local build' });
