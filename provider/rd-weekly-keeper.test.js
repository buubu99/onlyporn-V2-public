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
  const state = path.join(directory, 'state');
  fs.mkdirSync(path.join(state, 'run.lock'), { recursive: true });
  fs.mkdirSync(path.join(state, 'tmp.abandoned'));
  fs.writeFileSync(path.join(state, 'tmp.abandoned', 'private.json'), '{}');
  try {
    const result = spawnSync('zsh', [
      SCRIPT, '--check', '--report', report, '--config', config,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ONLYPORN_RD_STATE_DIR: state,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified:\s+1 code mappings/);
    assert.match(result.stdout, /Unique hash:\s+1/);
    assert.match(result.stdout, /Recovered a stale weekly keeper lock/);
    assert.match(result.stdout, /CHECK PASSED/);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.equal(fs.existsSync(path.join(state, 'run.lock')), false);
    assert.equal(fs.existsSync(path.join(state, 'tmp.abandoned')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('weekly RD keeper fetches missing torrent links and accepts a bounded HTTP 206 probe', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-rd-weekly-live-'));
  const report = path.join(directory, 'final-audit.json');
  const config = path.join(directory, 'aiostreams-config.json');
  const state = path.join(directory, 'state');
  const bin = path.join(directory, 'bin');
  const hash = '0123456789ABCDEF0123456789ABCDEF01234567';
  fs.mkdirSync(bin);
  fs.writeFileSync(report, JSON.stringify({ records: [{
    code: 'SONE-002', final_state: 'COMPLETE', status: 'downloaded', current_hash: hash,
  }] }));
  fs.writeFileSync(config, JSON.stringify({
    services: [{ id: 'realdebrid', credentials: { apiKey: 'fixture-token-never-print-this-value' } }],
  }));
  const fakeCurl = path.join(bin, 'curl');
  fs.writeFileSync(fakeCurl, `#!/bin/sh
outfile=""
url=""
want_out=0
for arg in "$@"; do
  if [ "$want_out" = 1 ]; then outfile="$arg"; want_out=0; continue; fi
  if [ "$arg" = "-o" ]; then want_out=1; continue; fi
  case "$arg" in http://*|https://*) url="$arg" ;; esac
done
case "$url" in
  */user) body='{"type":"premium"}' ;;
  *'/torrents?page='*) body='[{"id":"RD1","hash":"${hash}","status":"downloaded","links":[],"filename":"SONE-002.mp4"}]' ;;
  */torrents/info/RD1) body='{"id":"RD1","hash":"${hash}","status":"downloaded","links":["https://download.example/original"],"filename":"SONE-002.mp4"}' ;;
  */unrestrict/link) body='{"download":"https://cdn.example/file"}' ;;
  https://cdn.example/*) printf '206 0'; exit 63 ;;
  *) body='{"error":"unexpected fixture request"}' ;;
esac
[ "$outfile" = "/dev/null" ] || printf '%s' "$body" > "$outfile"
printf '200'
`);
  fs.chmodSync(fakeCurl, 0o700);
  const fakeSleep = path.join(bin, 'sleep');
  fs.writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeSleep, 0o700);
  try {
    const result = spawnSync('zsh', [
      SCRIPT, '--yes', '--report', report, '--config', config,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ONLYPORN_RD_STATE_DIR: state,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[1\/1\] OK SONE-002/);
    assert.match(result.stdout, /Freshness probes OK:\s+1/);
    assert.doesNotMatch(result.stdout, /NOT READY|FAILED/);
    assert.match(fs.readFileSync(path.join(state, 'history.jsonl'), 'utf8'), /"result":"TOUCH_OK"/);
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
  assert.match(source, /rc == 0 \|\| rc == 63/);
  assert.match(source, /torrents\/info\/\$torrent_id/);
  assert.match(source, /trap stop_safely INT TERM/);
  assert.match(source, /exit 130/);
  assert.match(source, /\.links\[0\]/);
  assert.match(source, /jq -rsc/);
  assert.doesNotMatch(source, /torrents\/delete/);
  assert.doesNotMatch(source, /downloads\/delete/);
  assert.doesNotMatch(source, /\blocal [^\n]*\bstatus=/);
  assert.doesNotMatch(source, /\bstatus="\$\(/);
});
