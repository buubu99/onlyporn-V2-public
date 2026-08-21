'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '../OnlyPorn_RD_Weekly_Keeper.command');

test('weekly RD keeper validates an audited-only fixture without exposing credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-rd-weekly-'));
  const report = path.join(directory, 'final-audit.json');
  const config = path.join(directory, 'aiostreams-config.json');
  const token = 'fixture-token-that-must-never-be-printed';
  fs.writeFileSync(report, JSON.stringify({
    records: [
      {
        code: 'SONE-002',
        final_state: 'COMPLETE',
        status: 'downloaded',
        current_hash: '0123456789abcdef0123456789abcdef01234567',
      },
      {
        code: 'MISSING-001',
        final_state: 'MISSING',
        status: 'missing',
        current_hash: null,
      },
    ],
  }));
  fs.writeFileSync(config, JSON.stringify({
    services: [{ id: 'realdebrid', credentials: { apiKey: token } }],
  }));
  try {
    const result = spawnSync('zsh', [
      SCRIPT, '--check', '--report', report, '--config', config,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ONLYPORN_RD_STATE_DIR: path.join(directory, 'state'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified:\s+1 code mappings/);
    assert.match(result.stdout, /Unique hash:\s+1/);
    assert.match(result.stdout, /CHECK PASSED/);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    assert.doesNotMatch(result.stderr, new RegExp(token));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('weekly RD keeper is scoped, resumable, rate-limited, and never deletes', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /final_state == "COMPLETE" and \.status == "downloaded"/);
  assert.match(source, /completed-\$RUN_KEY\.txt/);
  assert.match(source, /API_DELAY=1/);
  assert.match(source, /RESERVE_ACTIVE_SLOTS=10/);
  assert.match(source, /torrents\/addMagnet/);
  assert.match(source, /torrents\/selectFiles/);
  assert.match(source, /--range 0-0/);
  assert.match(source, /\.links\[0\]/);
  assert.match(source, /jq -rsc/);
  assert.doesNotMatch(source, /torrents\/delete/);
  assert.doesNotMatch(source, /downloads\/delete/);
});
