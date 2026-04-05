import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const postReleaseScript = join(repoRoot, 'scripts', 'post-release-followups.sh');

test('post-release follow-up script warns but succeeds when downstream sync fails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-post-release-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));

  const fakeSync = join(root, 'fake-sync.sh');
  writeFileSync(
    fakeSync,
    '#!/usr/bin/env bash\nset -euo pipefail\necho "sync failed on purpose" >&2\nexit 17\n',
  );
  chmodSync(fakeSync, 0o755);

  const result = spawnSync('bash', [postReleaseScript, '--version', '0.5.39', '--wait-for-publish'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_GPT_POST_RELEASE_SYNC_CMD: fakeSync,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /sync failed on purpose/u);
  assert.match(result.stderr, /published successfully, but downstream repo sync failed \(exit 17\)/u);
  assert.match(result.stderr, /pnpm run sync:repos -- --version 0\.5\.39 --wait-for-publish/u);
});
