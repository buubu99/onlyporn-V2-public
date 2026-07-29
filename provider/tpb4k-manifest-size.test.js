'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('TPB4K-enabled manifest constructs successfully and remains below 8 KiB', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `
        const addon = require('./addon');
        const serialized = JSON.stringify(addon.manifest);
        const result = {
          constructor: addon.constructor.name,
          catalogs: addon.manifest.catalogs.length,
          tpb4kCatalogs: addon.manifest.catalogs.filter(item => item.id.startsWith('tpb4k.')).length,
          bytes: Buffer.byteLength(serialized, 'utf8'),
          chars: serialized.length,
        };
        console.log(JSON.stringify(result));
        if (result.catalogs !== 37) process.exit(31);
        if (result.tpb4kCatalogs !== 28) process.exit(32);
        if (result.bytes >= 8192 || result.chars >= 8192) process.exit(33);
      `,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, TPB4K_ENABLED: 'true', LOG_ENABLED: 'false' },
      encoding: 'utf8',
    }
  );

  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});
