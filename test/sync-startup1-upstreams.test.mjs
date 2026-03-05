import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const syncScript = join(repoRoot, 'scripts', 'sync-startup1-upstreams.sh');
const wrapperTemplate = join(repoRoot, 'templates', 'startup1', 'chatgpt-oracle-review.sh');
const ensureTemplate = join(repoRoot, 'templates', 'startup1', 'review-gpt-ensure-published.sh');

test('sync script updates startup1 wrapper templates after dependency bump', (t) => {
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
printf '%s\n' "$*" >> "${pnpmLog}"
exit 0
`
  );
  spawnSync('chmod', ['+x', fakePnpm], { stdio: 'ignore' });

  const targetRepo = join(root, 'cli');
  mkdirSync(join(targetRepo, 'scripts'), { recursive: true });
  writeFileSync(
    join(targetRepo, 'package.json'),
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
  writeFileSync(join(targetRepo, 'scripts', 'chatgpt-oracle-review.sh'), '#!/usr/bin/env bash\necho stale\n');
  writeFileSync(join(targetRepo, 'scripts', 'review-gpt-ensure-published.sh'), '#!/usr/bin/env bash\necho stale\n');

  const result = spawnSync(
    'bash',
    [syncScript, '--version', '0.3.0', '--root', root, '--repos', 'cli'],
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
  assert.match(readFileSync(pnpmLog, 'utf8'), /up @cobuild\/review-gpt@0\.3\.0/);
  assert.equal(readFileSync(join(targetRepo, 'scripts', 'chatgpt-oracle-review.sh'), 'utf8'), readFileSync(wrapperTemplate, 'utf8'));
  assert.equal(
    readFileSync(join(targetRepo, 'scripts', 'review-gpt-ensure-published.sh'), 'utf8'),
    readFileSync(ensureTemplate, 'utf8')
  );
  assert.ok((statSync(join(targetRepo, 'scripts', 'chatgpt-oracle-review.sh')).mode & 0o111) !== 0);
  assert.ok((statSync(join(targetRepo, 'scripts', 'review-gpt-ensure-published.sh')).mode & 0o111) !== 0);
});
