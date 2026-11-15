import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { hashPassword } from './auth';

test('configured password survives Next.js environment loading with Unicode credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-alerts-env-'));
  const password = 'café 🚀 中文 → "quoted" \\password';
  try {
    writeFileSync(join(directory, '.env'), `ALERTS_PASSWORD_HASH='${hashPassword(password)}'\n`);
    const script = `
      import assert from 'node:assert/strict';
      import nextEnv from '@next/env';
      nextEnv.loadEnvConfig(${JSON.stringify(directory)}, true);
      // Auth imports dotenv, so load it only after exercising Next's environment expansion boundary.
      const { verifyPassword } = await import(${JSON.stringify(new URL('./auth.ts', import.meta.url).href)});
      assert.equal(verifyPassword(${JSON.stringify(password)}, process.env.ALERTS_PASSWORD_HASH), true);
      assert.equal(verifyPassword('wrong password', process.env.ALERTS_PASSWORD_HASH), false);
    `;
    const env = { ...process.env };
    delete env.ALERTS_PASSWORD_HASH;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
