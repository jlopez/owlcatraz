// `pnpm install:pr` — detect the PR for the current branch and load ITS build.
//
// The CD `package` job uploads a preview zip as an Actions artifact on every CI
// run (including PRs). We find the PR for the current branch, locate its most
// recent CI run, and download that artifact. Note the double-wrap: Actions
// stores the artifact as a zip whose single entry is our owlcatraz-<id>.zip, so
// `gh run download` yields a folder containing the real zip — hence findZip().

import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  capture,
  ensureGh,
  fail,
  findZip,
  freshTmp,
  handOff,
  info,
  ok,
  publishStable,
  run,
  sleep,
  unzipInto,
} from './install-common.mjs';

/** Most recent CI run for `branch`, or null if none has registered yet. */
function latestCiRun(branch) {
  const runs = JSON.parse(
    capture('gh', [
      'run',
      'list',
      '--branch',
      branch,
      '--workflow',
      'ci.yml',
      '--limit',
      '1',
      '--json',
      'databaseId,status,conclusion',
    ]),
  );
  return runs[0] ?? null;
}

ensureGh();

// Which PR are we on? `gh pr view` (no arg) resolves the PR for the current
// branch. Absence here is the expected "you're not on a PR branch" case.
let pr;
try {
  pr = JSON.parse(capture('gh', ['pr', 'view', '--json', 'number,headRefName,state']));
} catch {
  fail(
    'No open PR found for the current branch. Push your branch and open a PR, or use `pnpm install:local`.',
  );
}
if (pr.state !== 'OPEN') {
  fail(
    `The PR for this branch is ${pr.state}, not OPEN. Use \`pnpm install:latest\` or \`pnpm install:local\`.`,
  );
}
ok(`Found PR #${pr.number} (${pr.headRefName})`);

// Find the CI run for the PR's head branch. Right after a push the run can take
// a few seconds to register, so poll briefly (up to ~1 min) before giving up.
let ciRun = latestCiRun(pr.headRefName);
for (let waited = 0; !ciRun && waited < 60; waited += 5) {
  if (waited === 0) info('No CI run yet — waiting for one to start…');
  sleep(5);
  ciRun = latestCiRun(pr.headRefName);
}
if (!ciRun) {
  fail('No CI run has started for this PR. Confirm CI is enabled, then re-run.');
}

// The whole point of this script: if CI is still running, wait it out rather
// than bailing. `gh run watch` streams live job status and, with --exit-status,
// exits non-zero if the run ends in failure — which surfaces here as a throw.
if (ciRun.status !== 'completed') {
  ok(`PR #${pr.number} is still running CI (run ${ciRun.databaseId}) — waiting for it to finish…`);
  try {
    run('gh', ['run', 'watch', String(ciRun.databaseId), '--exit-status', '--interval', '15']);
  } catch {
    fail(
      `CI run ${ciRun.databaseId} finished with a failure — no usable preview build. Fix CI and re-run.`,
    );
  }
} else if (ciRun.conclusion !== 'success') {
  fail(
    `CI run ${ciRun.databaseId} concluded "${ciRun.conclusion}" — no usable preview build. Fix CI and re-run.`,
  );
}

const tmp = freshTmp('pr');
try {
  run('gh', ['run', 'download', String(ciRun.databaseId), '--dir', tmp]);
} catch {
  fail(`Could not download artifacts from run ${ciRun.databaseId}. The artifact may have expired.`);
}

const zip = findZip(tmp);
if (!zip) fail('Downloaded the run artifacts but found no owlcatraz-*.zip inside.');
ok(`Downloaded ${basename(zip)}`);

// Unpack into a staging dir, then atomically swap into the load dir, so a bad
// unzip can't wipe a working install.
const staged = join(tmp, 'staged');
unzipInto(zip, staged);
publishStable(staged);
rmSync(tmp, { recursive: true, force: true });

handOff({ sourceLabel: `PR #${pr.number} build` });
