import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const source = new URL('../', import.meta.url);

test('LongTaskControlS12 locked parser loads from installed Worker plugin layout', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', source), 'utf8'));
  assert.equal(manifest.dependencies?.['bash-parser'], '0.5.0');
  const lock = readFileSync(new URL('package-lock.json', source), 'utf8');
  const fixture = mkdtempSync(path.join(tmpdir(), 'muad-command-package-'));
  const plugin = path.join(fixture, 'opt/muad/muad-runtime-guard');
  try {
    mkdirSync(path.join(plugin, 'src'), { recursive: true });
    writeFileSync(path.join(plugin, 'package.json'), JSON.stringify(manifest));
    writeFileSync(path.join(plugin, 'package-lock.json'), lock);
    const require = createRequire(path.join(plugin, 'src/long-task-command-policy.mjs'));
    assert.throws(() => require('bash-parser'), { code: 'MODULE_NOT_FOUND' });
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit'], {
      cwd: plugin, stdio: 'pipe', timeout: 30_000,
    });
    const parse = require('bash-parser');
    assert.equal(parse('cd scripts && env X=1 python run.py').type, 'Script');
    assert.match(require.resolve('bash-parser'), new RegExp(`${plugin}/node_modules/`));
    const dockerfile = readFileSync(new URL('../../Dockerfile', source), 'utf8');
    assert.match(dockerfile, /COPY tools\/muad-runtime-guard\/package\.json tools\/muad-runtime-guard\/package-lock\.json/);
    assert.match(dockerfile, /COPY --from=runtime-guard-deps .*node_modules \/opt\/muad\/muad-runtime-guard\/node_modules/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
