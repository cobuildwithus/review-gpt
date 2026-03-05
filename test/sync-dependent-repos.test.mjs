import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const syncScript = join(repoRoot, 'scripts', 'sync-dependent-repos.sh');

test('sync script updates discovered dependent repos only', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-gpt-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const pnpmLog = join(root, 'pnpm.log');
  const fakePnpm = join(fakeBin, 'pnpm');
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$PWD :: $*" >> "${pnpmLog}"
exit 0
`
  );
  spawnSync('chmod', ['+x', fakePnpm], { stdio: 'ignore' });

  const depRepo = join(root, 'cli');
  mkdirSync(depRepo, { recursive: true });
  writeFileSync(
    join(depRepo, 'package.json'),
    JSON.stringify(
      {
        name: 'tmp-cli',
        devDependencies: {
          '@cobuild/review-gpt': '^0.2.9',
        },
      },
      null,
      2
    )
  );

  const skippedRepo = join(root, 'docs');
  mkdirSync(skippedRepo, { recursive: true });
  writeFileSync(join(skippedRepo, 'package.json'), JSON.stringify({ name: 'tmp-docs' }, null, 2));

  const result = spawnSync(
    'bash',
    [syncScript, '--version', '0.3.0', '--root', root],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Repo set: cli/);
  assert.match(readFileSync(pnpmLog, 'utf8'), new RegExp(`${depRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} :: up @cobuild/review-gpt@0\\.3\\.0`));
});
