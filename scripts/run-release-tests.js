#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROVIDER_DIR = path.join(ROOT, 'provider');
const LIVE_PROVIDER_TESTS = new Set([
  'provider/provider.test.js',
  'provider/spankbang-production-retrieval.test.js',
]);

const allTests = fs.readdirSync(PROVIDER_DIR)
  .filter(name => name.endsWith('.test.js'))
  .map(name => `provider/${name}`)
  .sort();

for (const liveTest of LIVE_PROVIDER_TESTS) {
  if (!allTests.includes(liveTest)) {
    process.stderr.write(`Release test classification is stale: ${liveTest} is missing\n`);
    process.exit(1);
  }
}

const releaseTests = allTests.filter(testFile => !LIVE_PROVIDER_TESTS.has(testFile));
if (releaseTests.length + LIVE_PROVIDER_TESTS.size !== allTests.length) {
  process.stderr.write('Every provider test must be classified exactly once\n');
  process.exit(1);
}

process.stdout.write(
  `Running ${releaseTests.length} deterministic release files; ` +
  `${LIVE_PROVIDER_TESTS.size} live-provider files are gated separately.\n`
);

const result = spawnSync(process.execPath, ['--test', ...releaseTests], {
  cwd: ROOT,
  env: {
    ...process.env,
    ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
