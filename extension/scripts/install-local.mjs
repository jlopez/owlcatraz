// `pnpm install:local` — build from the working tree and load that.
//
// No network, no gh: just `pnpm build` and copy dist/ into the stable dir. We
// keep sourcemaps here (unlike the CD zip, which strips them) — for a local
// build you're more likely to want to debug than to minimise size.

import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { EXT_ROOT, STABLE_DIR, fail, handOff, ok, resetStableDir, run } from './install-common.mjs';

run('pnpm', ['build'], { cwd: EXT_ROOT });

const dist = join(EXT_ROOT, 'dist');
if (!existsSync(dist)) fail('Build finished but dist/ is missing — check the build output above.');

resetStableDir();
cpSync(dist, STABLE_DIR, { recursive: true });
ok('Copied dist/ → stable load directory');

handOff({ sourceLabel: 'Local build' });
