'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const analyzer = require('../scripts/opn-rd-weekly-analyzer');
const SCRIPT = path.resolve(__dirname, '../scripts/opn-rd-weekly-analyzer.js');
const WRAPPER = path.resolve(__dirname, '../OPN_RD_Weekly_Analyzer.command');

test('weekly analyzer separates historical failure types', () => {
  assert.equal(analyzer.classifyHistorical('TOUCH_FAILED', 'hoster_unavailable'), 'touch_hoster_unavailable');
  assert.equal(analyzer.classifyHistorical('TOUCH_FAILED', 'one-byte probe failed (HTTP 403)'), 'direct_probe_failed');
  assert.equal(analyzer.classifyHistorical('PRESENT_NOT_READY', 'waiting_files_selection'), 'waiting_file_selection');
  assert.equal(analyzer.classifyHistorical('PRESENT_NOT_READY', 'dead'), 'terminal_needs_tournament');
  assert.equal(analyzer.classifyHistorical('TORRENT_INFO_FAILED', 'network_timeout'), 'torrent_info_failed');
});

test('weekly analyzer tries the exact selected video link before unrelated files', () => {
  const rows = analyzer.selectedVideoLinks({
    filename: 'torrent',
    files: [
      { id: 1, path: '/sample.mp4', bytes: 2_000, selected: 1 },
      { id: 2, path: '/SONE-675.mp4', bytes: 1_000, selected: 1 },
      { id: 3, path: '/notes.txt', bytes: 3_000, selected: 1 },
    ],
    links: ['https://rd.example/sample', 'https://rd.example/exact', 'https://rd.example/text'],
  }, 'SONE-675');
  assert.equal(rows[0].filename, '/SONE-675.mp4');
  assert.equal(rows[0].link, 'https://rd.example/exact');
  assert.equal(rows[0].exact, true);
  assert.deepEqual(analyzer.chooseVideoFileIds({ files: [
    { id: 1, path: '/sample.mp4', bytes: 2_000 },
    { id: 2, path: '/SONE-675.mp4', bytes: 1_000 },
  ] }, 'SONE-675'), [2]);
});

test('weekly analyzer reconstructs only unresolved hashes and writes separated local analysis', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opn-rd-analyzer-'));
  const state = path.join(directory, 'state');
  const report = path.join(directory, 'audit.json');
  const summary = path.join(state, 'last-summary.json');
  const history = path.join(state, 'history.jsonl');
  fs.mkdirSync(state);
  const records = [
    { code: 'OK-001', final_state: 'COMPLETE', status: 'downloaded', current_hash: '1'.repeat(40), candidate_count: 1 },
    { code: 'FAIL-002', final_state: 'COMPLETE', status: 'downloaded', current_hash: '2'.repeat(40), candidate_count: 1 },
    { code: 'WAIT-003', final_state: 'COMPLETE', status: 'downloaded', current_hash: '3'.repeat(40), candidate_count: 2 },
  ];
  fs.writeFileSync(report, JSON.stringify({ records }));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(report)).digest('hex');
  fs.writeFileSync(summary, JSON.stringify({
    finishedAt: '2026-08-22T01:33:25Z', week: '2026-W34', report, reportSha256: sha,
    verifiedCodes: 3, targetHashes: 3, completedThisWeek: 1, failed: 2,
  }));
  fs.writeFileSync(history, [
    { week: '2026-W34', reportSha256: sha, code: 'OK-001', hash: '1'.repeat(40), result: 'TOUCH_OK', detail: 'OK-001.mp4' },
    { week: '2026-W34', reportSha256: sha, code: 'FAIL-002', hash: '2'.repeat(40), result: 'TOUCH_FAILED', detail: 'hoster_unavailable' },
    { week: '2026-W34', reportSha256: sha, code: 'WAIT-003', hash: '3'.repeat(40), result: 'PRESENT_NOT_READY', detail: 'downloading' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(state, `completed-2026-W34-${sha.slice(0, 12)}.txt`), `${'1'.repeat(40)}\n`);
  try {
    const context = analyzer.loadFailureCases({ stateDir: state, summary, history, report });
    assert.equal(context.cases.length, 2);
    assert.deepEqual(context.cases.map(row => row.initialCategory).sort(), [
      'present_not_ready', 'touch_hoster_unavailable',
    ]);
    const result = spawnSync(process.execPath, [
      SCRIPT, '--analyze-only', '--state-dir', state, '--summary', summary, '--history', history, '--report', report,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Unresolved hashes:\s+2/);
    assert.match(result.stdout, /touch_hoster_unavailable: 1/);
    assert.match(result.stdout, /present_not_ready: 1/);
    const runs = fs.readdirSync(path.join(state, 'OPN-Analyzer'));
    const categories = path.join(state, 'OPN-Analyzer', runs[0], 'categories');
    assert.equal(fs.existsSync(path.join(categories, 'touch_hoster_unavailable.json')), true);
    assert.equal(fs.existsSync(path.join(categories, 'present_not_ready.json')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('weekly analyzer wrapper is executable, resumable, and never deletes RD entries', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const wrapper = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(wrapper, /opn-rd-weekly-analyzer\.js/);
  assert.match(source, /completed-\$\{summary\.week\}-\$\{reportSha256\.slice\(0, 12\)\}\.txt/);
  assert.match(source, /torrents\/addMagnet/);
  assert.match(source, /torrents\/selectFiles/);
  assert.match(source, /Range: 'bytes=0-0'/);
  assert.match(source, /clone_hoster_unavailable_needs_alternate_hash/);
  assert.match(source, /activeLimit - 10/);
  assert.doesNotMatch(source, /torrents\/delete/);
  assert.doesNotMatch(source, /downloads\/delete/);
});
