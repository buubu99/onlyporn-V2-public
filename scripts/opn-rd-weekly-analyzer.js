#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const DEFAULT_API = 'https://api.real-debrid.com/rest/1.0';
const DEFAULT_STATE_DIR = path.join(
  process.env.HOME || '/Users/Buubuu',
  'Library/Application Support/OnlyPorn/RD-Weekly-Keeper'
);
const VIDEO_EXTENSION = /\.(?:mp4|mkv|avi|mov|m4v|wmv|webm|ts)$/i;
const TERMINAL_STATUSES = new Set(['dead', 'error', 'magnet_error', 'virus']);
const PENDING_STATUSES = new Set([
  'magnet_conversion', 'waiting_files_selection', 'queued', 'downloading', 'compressing', 'uploading',
]);
const SUCCESS_RESULTS = new Set([
  'TOUCH_OK', 'REPAIRED_AND_TOUCHED', 'ANALYZER_TOUCH_OK', 'ANALYZER_CLONE_TOUCH_OK',
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    analyzeOnly: false,
    assumeYes: false,
    clone: true,
    sweepWaitSeconds: 60,
    stateDir: process.env.OPN_RD_STATE_DIR || process.env.ONLYPORN_RD_STATE_DIR || DEFAULT_STATE_DIR,
    summary: '',
    history: '',
    report: '',
    config: '',
    api: process.env.OPN_RD_API || DEFAULT_API,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--analyze-only' || token === '--check') args.analyzeOnly = true;
    else if (token === '--yes') args.assumeYes = true;
    else if (token === '--no-clone' || token === '--retry-only') args.clone = false;
    else if (token === '--state-dir') args.stateDir = argv[++index] || '';
    else if (token === '--summary') args.summary = argv[++index] || '';
    else if (token === '--history') args.history = argv[++index] || '';
    else if (token === '--report') args.report = argv[++index] || '';
    else if (token === '--config') args.config = argv[++index] || '';
    else if (token === '--api') args.api = argv[++index] || '';
    else if (token === '--sweep-wait-seconds') {
      args.sweepWaitSeconds = Number.parseInt(argv[++index] || '', 10);
    } else if (token === '-h' || token === '--help') args.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  if (!args.stateDir) throw new Error('--state-dir requires a path');
  if (!Number.isInteger(args.sweepWaitSeconds) || args.sweepWaitSeconds < 0 || args.sweepWaitSeconds > 900) {
    throw new Error('--sweep-wait-seconds must be between 0 and 900');
  }
  return args;
}

function usage() {
  return [
    'Usage: OPN_RD_Weekly_Analyzer.command [options]',
    '',
    '  --analyze-only           Classify local weekly failures without contacting RD',
    '  --retry-only             Retry existing RD links but do not create exact-hash clones',
    '  --yes                    Skip the repair confirmation prompt',
    '  --sweep-wait-seconds N   Delay between the two fresh-link sweeps (default 60)',
    '  --summary PATH           Override last-summary.json',
    '  --history PATH           Override history.jsonl',
    '  --report PATH            Override the audited hash report',
    '  --config PATH            Override the AIOStreams configuration',
    '  --state-dir PATH         Override the weekly keeper state directory',
  ].join('\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizedHash(value) {
  const hash = String(value || '').trim().toUpperCase();
  return /^[A-F0-9]{40}$/.test(hash) ? hash : '';
}

function normalizedCodes(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(code => code.trim().toUpperCase())
    .filter(Boolean))];
}

function compactCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function publicCase(row) {
  return {
    codes: row.codes,
    hash: row.hash,
    initialResult: row.initialResult,
    initialDetail: row.initialDetail,
    initialCategory: row.initialCategory,
    hashRelation: row.hashRelation,
    candidateCount: row.candidateCount,
    auditedStatus: row.auditedStatus,
    auditedFilename: row.auditedFilename,
  };
}

function classifyHistorical(result, detail) {
  const normalizedResult = String(result || '').toUpperCase();
  const normalizedDetail = String(detail || '').toLowerCase();
  if (SUCCESS_RESULTS.has(normalizedResult)) return 'success';
  if (normalizedResult === 'TOUCH_FAILED' && normalizedDetail.includes('hoster_unavailable')) {
    return 'touch_hoster_unavailable';
  }
  if (normalizedResult === 'TOUCH_FAILED' && normalizedDetail.includes('one-byte probe failed')) {
    return 'direct_probe_failed';
  }
  if (normalizedResult === 'TORRENT_INFO_FAILED') return 'torrent_info_failed';
  if (normalizedResult === 'PRESENT_NOT_READY') {
    if (normalizedDetail === 'waiting_files_selection') return 'waiting_file_selection';
    if (TERMINAL_STATUSES.has(normalizedDetail)) return 'terminal_needs_tournament';
    return 'present_not_ready';
  }
  if (normalizedResult === 'MISSING_REPAIR_DISABLED') return 'missing_repair_disabled';
  if (normalizedResult === 'REPAIR_PENDING') return 'repair_pending';
  if (normalizedResult === 'REPAIR_FAILED') return 'repair_failed';
  if (normalizedResult === 'REPAIR_TOUCH_FAILED' && normalizedDetail.includes('hoster_unavailable')) {
    return 'repair_hoster_unavailable';
  }
  return 'unclassified';
}

function readHistory(filePath, week, reportSha256) {
  const rows = [];
  const invalidLines = [];
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const row = JSON.parse(line);
      if (row.week === week && row.reportSha256 === reportSha256) rows.push(row);
    } catch (_error) {
      invalidLines.push(index + 1);
    }
  });
  return { rows, invalidLines };
}

function loadCompleted(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) return new Set();
  return new Set(fs.readFileSync(checkpointPath, 'utf8')
    .split(/\r?\n/)
    .map(normalizedHash)
    .filter(Boolean));
}

function loadFailureCases(options = {}) {
  const stateDir = options.stateDir || DEFAULT_STATE_DIR;
  const summaryPath = options.summary || path.join(stateDir, 'last-summary.json');
  const historyPath = options.history || path.join(stateDir, 'history.jsonl');
  if (!fs.existsSync(summaryPath)) throw new Error(`Weekly summary not found: ${summaryPath}`);
  if (!fs.existsSync(historyPath)) throw new Error(`Weekly history not found: ${historyPath}`);
  const summary = readJson(summaryPath);
  const reportPath = options.report || summary.report;
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`Audited report not found: ${reportPath || '(empty)'}`);
  const reportSha256 = fileSha256(reportPath);
  if (reportSha256 !== summary.reportSha256) {
    throw new Error(`Audited report checksum changed: ${reportSha256}`);
  }
  const report = readJson(reportPath);
  const targets = new Map();
  for (const record of Array.isArray(report.records) ? report.records : []) {
    if (record.final_state !== 'COMPLETE' || record.status !== 'downloaded') continue;
    const hash = normalizedHash(record.current_hash);
    if (!hash) continue;
    const existing = targets.get(hash) || {
      hash,
      codes: [],
      hashRelation: record.hash_relation || '',
      candidateCount: Number(record.candidate_count || 0),
      auditedStatus: record.status || '',
      auditedFilename: record.filename || '',
      auditedRdId: record.current_rd_id || '',
    };
    existing.codes.push(String(record.code || '').toUpperCase());
    existing.codes = [...new Set(existing.codes.filter(Boolean))].sort();
    existing.candidateCount = Math.max(existing.candidateCount, Number(record.candidate_count || 0));
    targets.set(hash, existing);
  }
  if (targets.size !== Number(summary.targetHashes)) {
    throw new Error(`Target count mismatch: report=${targets.size}, summary=${summary.targetHashes}`);
  }
  const { rows: historyRows, invalidLines } = readHistory(historyPath, summary.week, reportSha256);
  const latest = new Map();
  for (const row of historyRows) {
    const hash = normalizedHash(row.hash);
    if (hash && targets.has(hash)) latest.set(hash, row);
  }
  const checkpointPath = path.join(stateDir, `completed-${summary.week}-${reportSha256.slice(0, 12)}.txt`);
  const completed = loadCompleted(checkpointPath);
  const cases = [];
  for (const [hash, target] of targets) {
    if (completed.has(hash)) continue;
    const event = latest.get(hash);
    const initialResult = event?.result || 'NO_HISTORY';
    if (SUCCESS_RESULTS.has(initialResult)) continue;
    cases.push({
      ...target,
      codes: target.codes.join(','),
      initialResult,
      initialDetail: event?.detail || '',
      initialTime: event?.time || '',
      initialCategory: classifyHistorical(initialResult, event?.detail || ''),
    });
  }
  cases.sort((left, right) => left.codes.localeCompare(right.codes) || left.hash.localeCompare(right.hash));
  return {
    stateDir,
    summaryPath,
    historyPath,
    reportPath,
    reportSha256,
    summary,
    report,
    checkpointPath,
    completed,
    historyRows,
    invalidLines,
    cases,
  };
}

function groupCases(cases, field = 'initialCategory') {
  const groups = {};
  for (const row of cases) {
    const key = String(row[field] || 'unclassified').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

function writeJsonPrivate(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function createAnalysisDirectory(context) {
  const root = path.join(context.stateDir, 'OPN-Analyzer');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(root, stamp);
  const categoriesDirectory = path.join(directory, 'categories');
  fs.mkdirSync(categoriesDirectory, { recursive: true, mode: 0o700 });
  const groups = groupCases(context.cases);
  for (const [category, cases] of Object.entries(groups)) {
    writeJsonPrivate(path.join(categoriesDirectory, `${category}.json`), cases.map(publicCase));
  }
  const analysis = {
    generatedAt: new Date().toISOString(),
    week: context.summary.week,
    report: context.reportPath,
    reportSha256: context.reportSha256,
    auditedCodes: context.summary.verifiedCodes,
    targetHashes: context.summary.targetHashes,
    completedHashes: context.completed.size,
    unresolvedHashes: context.cases.length,
    invalidHistoryLines: context.invalidLines,
    categories: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.length])),
    cases: context.cases.map(publicCase),
  };
  writeJsonPrivate(path.join(directory, 'initial-analysis.json'), analysis);
  return { directory, categoriesDirectory, analysis };
}

function discoverConfig(explicitPath) {
  if (explicitPath) return explicitPath;
  const downloads = '/Users/Buubuu/Downloads';
  if (!fs.existsSync(downloads)) return '';
  return fs.readdirSync(downloads)
    .filter(name => /^aiostreams-config-.*\.json$/i.test(name))
    .map(name => ({ path: path.join(downloads, name), mtime: fs.statSync(path.join(downloads, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0]?.path || '';
}

function loadRdToken(configPath) {
  const environmentToken = String(process.env.RD_TOKEN || '');
  if (environmentToken.length >= 16) return environmentToken;
  if (!configPath || !fs.existsSync(configPath)) throw new Error(`AIOStreams config not found: ${configPath || '(empty)'}`);
  const config = readJson(configPath);
  for (const service of Array.isArray(config.services) ? config.services : []) {
    if (String(service?.id || '').toLowerCase() !== 'realdebrid') continue;
    const token = String(service?.credentials?.apiKey || '');
    if (token.length >= 16) return token;
  }
  throw new Error('Real-Debrid credential was not found in the AIOStreams config');
}

class RdError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'RdError';
    this.code = String(code || 'rd_request_failed');
    this.status = Number(status || 0);
  }
}

class RdClient {
  constructor({ token, api = DEFAULT_API, delayMs = 1_100 }) {
    this.token = token;
    this.api = String(api).replace(/\/$/, '');
    this.delayMs = delayMs;
    this.lastRequestAt = 0;
  }

  async pace() {
    const waitMs = Math.max(this.delayMs - (Date.now() - this.lastRequestAt), 0);
    if (waitMs) await sleep(waitMs);
  }

  async request(endpoint, options = {}) {
    const attempts = Math.max(Number(options.attempts || 4), 1);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.pace();
      this.lastRequestAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 45_000));
      try {
        const headers = { Authorization: `Bearer ${this.token}` };
        let body;
        if (options.form) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          body = new URLSearchParams(options.form).toString();
        }
        const response = await fetch(`${this.api}/${String(endpoint).replace(/^\//, '')}`, {
          method: options.method || 'GET', headers, body, signal: controller.signal,
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch (_error) { payload = {}; }
        if (response.ok) return payload;
        const code = String(payload?.error || `http_${response.status}`);
        const error = new RdError(code, response.status);
        if (response.status === 401 || response.status === 403) throw error;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === attempts || code === 'hoster_unavailable') throw error;
        lastError = error;
        await sleep(response.status === 429 ? 65_000 : attempt * 15_000);
      } catch (error) {
        if (error instanceof RdError) {
          if (error.status === 401 || error.status === 403 || error.code === 'hoster_unavailable'
              || (error.status >= 400 && error.status < 500 && error.status !== 429)) throw error;
          lastError = error;
        } else {
          lastError = new RdError(error?.name === 'AbortError' ? 'network_timeout' : 'network_error');
        }
        if (attempt === attempts) throw lastError;
        await sleep(attempt * 10_000);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new RdError('rd_request_failed');
  }

  async listTorrents() {
    const rows = [];
    for (let page = 1; ; page += 1) {
      const pageRows = await this.request(`torrents?page=${page}&limit=5000`);
      if (!Array.isArray(pageRows)) throw new RdError('torrent_list_not_array');
      rows.push(...pageRows);
      if (pageRows.length < 5000) break;
    }
    return rows;
  }

  async info(id) {
    return this.request(`torrents/info/${encodeURIComponent(String(id))}`);
  }

  async unrestrict(link) {
    return this.request('unrestrict/link', {
      method: 'POST', attempts: 1, form: { link: String(link), remote: '0' },
    });
  }
}

function torrentIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const hash = normalizedHash(row?.hash);
    if (!hash) continue;
    if (!index.has(hash)) index.set(hash, []);
    index.get(hash).push(row);
  }
  for (const candidates of index.values()) {
    candidates.sort((left, right) => {
      const leftReady = left.status === 'downloaded' && Array.isArray(left.links) && left.links.length ? 1 : 0;
      const rightReady = right.status === 'downloaded' && Array.isArray(right.links) && right.links.length ? 1 : 0;
      return rightReady - leftReady;
    });
  }
  return index;
}

function selectedVideoLinks(info, codes) {
  const links = Array.isArray(info?.links) ? info.links.map(String) : [];
  const selectedFiles = (Array.isArray(info?.files) ? info.files : []).filter(file => Number(file?.selected) === 1);
  const wanted = normalizedCodes(codes).map(compactCode).filter(Boolean);
  const candidates = [];
  if (selectedFiles.length && selectedFiles.length === links.length) {
    selectedFiles.forEach((file, index) => {
      const filename = String(file?.path || '');
      const compact = compactCode(filename);
      candidates.push({
        link: links[index],
        filename,
        bytes: Number(file?.bytes || 0),
        video: VIDEO_EXTENSION.test(filename),
        exact: wanted.some(code => code && compact.includes(code)),
      });
    });
  } else {
    links.forEach(link => candidates.push({
      link,
      filename: String(info?.filename || ''),
      bytes: Number(info?.bytes || 0),
      video: VIDEO_EXTENSION.test(String(info?.filename || '')),
      exact: wanted.some(code => compactCode(info?.filename).includes(code)),
    }));
  }
  const seen = new Set();
  return candidates
    .filter(candidate => candidate.link && !seen.has(candidate.link) && seen.add(candidate.link))
    .sort((left, right) => Number(right.exact) - Number(left.exact)
      || Number(right.video) - Number(left.video)
      || right.bytes - left.bytes);
}

function chooseVideoFileIds(info, codes) {
  const wanted = normalizedCodes(codes).map(compactCode).filter(Boolean);
  const videos = (Array.isArray(info?.files) ? info.files : [])
    .filter(file => VIDEO_EXTENSION.test(String(file?.path || '')))
    .map(file => ({
      id: Number(file.id),
      bytes: Number(file.bytes || 0),
      exact: wanted.some(code => compactCode(file.path).includes(code)),
    }))
    .filter(file => Number.isInteger(file.id));
  const exact = videos.filter(file => file.exact).sort((left, right) => right.bytes - left.bytes);
  const selected = exact.length ? exact : videos.sort((left, right) => right.bytes - left.bytes).slice(0, 1);
  return selected.slice(0, 3).map(file => file.id);
}

async function probeDownload(downloadUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(downloadUrl, {
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    if (!response.body) return { ok: false, detail: `HTTP ${response.status} without body` };
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => {});
    return first.value?.byteLength > 0
      ? { ok: true, detail: `HTTP ${response.status}; ${first.value.byteLength} byte probe` }
      : { ok: false, detail: `HTTP ${response.status}; empty body` };
  } catch (error) {
    return { ok: false, detail: error?.name === 'AbortError' ? 'probe timeout' : 'probe network error' };
  } finally {
    clearTimeout(timer);
  }
}

async function touchInfo(client, info, codes) {
  const candidates = selectedVideoLinks(info, codes);
  if (!candidates.length) return { ok: false, category: 'downloaded_without_links', detail: 'no selected video link' };
  const failures = [];
  for (const candidate of candidates) {
    try {
      const unrestricted = await client.unrestrict(candidate.link);
      const download = String(unrestricted?.download || '');
      if (!download) {
        failures.push('unrestrict returned no download');
        continue;
      }
      const probe = await probeDownload(download);
      if (probe.ok) return { ok: true, category: 'recovered_existing_link', detail: candidate.filename || 'selected video' };
      failures.push(probe.detail);
    } catch (error) {
      failures.push(error instanceof RdError ? error.code : 'unrestrict_error');
    }
  }
  if (failures.length && failures.every(detail => detail === 'hoster_unavailable')) {
    return { ok: false, category: 'touch_hoster_unavailable', detail: 'hoster_unavailable' };
  }
  return { ok: false, category: 'direct_probe_failed', detail: [...new Set(failures)].join(', ') };
}

async function selectExistingFiles(client, info, codes) {
  const ids = chooseVideoFileIds(info, codes);
  if (!ids.length) return { ok: false, category: 'terminal_needs_tournament', detail: 'no selectable video file' };
  await client.request(`torrents/selectFiles/${encodeURIComponent(String(info.id))}`, {
    method: 'POST', form: { files: ids.join(',') },
  });
  return { ok: false, category: 'present_not_ready', detail: 'video selected; RD processing pending' };
}

async function repairExactHashClone(client, row, options = {}) {
  const active = await client.request('torrents/activeCount');
  const activeCount = Number(active?.nb || 0);
  const activeLimit = Number(active?.limit || 0);
  if (activeLimit > 0 && activeCount >= activeLimit - 10) {
    return { ok: false, category: 'deferred_active_capacity', detail: `active reserve reached (${activeCount}/${activeLimit})` };
  }
  const added = await client.request('torrents/addMagnet', {
    method: 'POST', form: { magnet: `magnet:?xt=urn:btih:${row.hash}` },
  });
  const id = String(added?.id || '');
  if (!id) return { ok: false, category: 'clone_api_error', detail: 'RD returned no torrent ID' };
  let info;
  for (let poll = 0; poll < 8; poll += 1) {
    if (poll) await sleep(Number(options.metadataPollMs || 5_000));
    info = await client.info(id);
    if (info.status === 'downloaded' && Array.isArray(info.links) && info.links.length) break;
    if (info.status === 'waiting_files_selection') {
      const ids = chooseVideoFileIds(info, row.codes);
      if (!ids.length) return { ok: false, category: 'terminal_needs_tournament', detail: 'clone contains no video file' };
      await client.request(`torrents/selectFiles/${encodeURIComponent(id)}`, {
        method: 'POST', form: { files: ids.join(',') },
      });
      continue;
    }
    if (TERMINAL_STATUSES.has(String(info.status || ''))) {
      return { ok: false, category: 'terminal_needs_tournament', detail: `exact-hash clone became ${info.status}` };
    }
  }
  for (let poll = 0; poll < 10; poll += 1) {
    if (info?.status === 'downloaded' && Array.isArray(info.links) && info.links.length) {
      const touched = await touchInfo(client, info, row.codes);
      if (touched.ok) return { ...touched, category: 'recovered_exact_hash_clone', cloneId: id };
      if (touched.category === 'touch_hoster_unavailable') {
        return { ok: false, category: 'clone_hoster_unavailable_needs_alternate_hash', detail: touched.detail, cloneId: id };
      }
      return { ...touched, cloneId: id };
    }
    if (poll) await sleep(Number(options.downloadPollMs || 15_000));
    info = await client.info(id);
    if (TERMINAL_STATUSES.has(String(info.status || ''))) {
      return { ok: false, category: 'terminal_needs_tournament', detail: `exact-hash clone became ${info.status}`, cloneId: id };
    }
  }
  return { ok: false, category: 'clone_pending', detail: `exact-hash clone status ${info?.status || 'unknown'}`, cloneId: id };
}

function appendPrivate(filePath, value) {
  fs.appendFileSync(filePath, value, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function markCompleted(checkpointPath, hash, completedSet) {
  if (completedSet.has(hash)) return;
  appendPrivate(checkpointPath, `${hash}\n`);
  completedSet.add(hash);
}

function analyzerEvent(context, row, result) {
  const event = {
    time: new Date().toISOString(),
    week: context.summary.week,
    reportSha256: context.reportSha256,
    codes: row.codes,
    hash: row.hash,
    initialCategory: row.initialCategory,
    finalCategory: result.category,
    success: Boolean(result.ok),
    detail: String(result.detail || ''),
    action: String(result.action || ''),
  };
  appendPrivate(path.join(context.stateDir, 'analyzer-history.jsonl'), `${JSON.stringify(event)}\n`);
  return event;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_error) { return false; }
}

function activeLockPid(lockDirectory) {
  const pidPath = path.join(lockDirectory, 'pid');
  if (!fs.existsSync(pidPath)) return 0;
  const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
  return processIsAlive(pid) ? pid : 0;
}

function acquireLock(context) {
  const keeperLock = path.join(context.stateDir, 'run.lock');
  const keeperPid = activeLockPid(keeperLock);
  if (keeperPid) throw new Error(`Weekly keeper is still running (PID ${keeperPid})`);
  const lock = path.join(context.stateDir, 'analyzer.lock');
  if (fs.existsSync(lock)) {
    const pid = activeLockPid(lock);
    if (pid) throw new Error(`Another analyzer is already running (PID ${pid})`);
    fs.rmSync(path.join(lock, 'pid'), { force: true });
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
  return () => {
    fs.rmSync(path.join(lock, 'pid'), { force: true });
    try { fs.rmdirSync(lock); } catch (_error) { /* already removed */ }
  };
}

async function confirmRepair(cases, cloneEnabled) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Retry ${cases.length} unresolved audited hashes${cloneEnabled ? ' and clone the exact hash when required' : ''}? [y/N] `
    );
    return /^y/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function runRepair(context, analysisOutput, args) {
  const configPath = discoverConfig(args.config);
  const token = loadRdToken(configPath);
  const client = new RdClient({ token, api: args.api });
  const user = await client.request('user');
  if (user?.type !== 'premium') throw new Error('RD account is not currently premium');
  console.log(`Credential: ${path.basename(configPath || 'RD_TOKEN')} (token not logged)`);
  console.log('Reading the complete RD torrent library...');
  const library = await client.listTorrents();
  let index = torrentIndex(library);
  console.log(`Current RD entries: ${library.length}`);

  const results = new Map();
  let retryQueue = [];
  for (let position = 0; position < context.cases.length; position += 1) {
    const row = context.cases[position];
    const candidates = index.get(row.hash) || [];
    const prefix = `[${position + 1}/${context.cases.length}] ${row.codes}`;
    if (!candidates.length) {
      const result = { ok: false, category: 'missing_from_rd', detail: 'audited hash is absent', action: 'queue exact-hash clone' };
      results.set(row.hash, result);
      retryQueue.push(row);
      console.log(`${prefix}: MISSING`);
      continue;
    }
    let info = candidates[0];
    if (info.id) {
      try { info = await client.info(info.id); } catch (error) {
        const result = { ok: false, category: 'torrent_info_failed', detail: error.code || 'torrent info failed', action: 'retry later' };
        results.set(row.hash, result);
        retryQueue.push(row);
        console.log(`${prefix}: INFO FAILED — ${result.detail}`);
        continue;
      }
    }
    const currentStatus = String(info?.status || 'unknown');
    if (currentStatus === 'downloaded') {
      const result = await touchInfo(client, info, row.codes);
      results.set(row.hash, { ...result, action: result.ok ? 'fresh-link probe' : 'queue second fresh-link sweep' });
      if (result.ok) {
        markCompleted(context.checkpointPath, row.hash, context.completed);
        analyzerEvent(context, row, results.get(row.hash));
        console.log(`${prefix}: RECOVERED`);
      } else {
        retryQueue.push(row);
        console.log(`${prefix}: ${result.category.toUpperCase()}`);
      }
    } else if (currentStatus === 'waiting_files_selection') {
      const result = await selectExistingFiles(client, info, row.codes);
      results.set(row.hash, { ...result, action: 'selected existing video files' });
      analyzerEvent(context, row, results.get(row.hash));
      console.log(`${prefix}: FILES SELECTED; PENDING`);
    } else if (TERMINAL_STATUSES.has(currentStatus)) {
      const result = { ok: false, category: 'terminal_needs_tournament', detail: currentStatus, action: 'preserved entry; alternate hash required' };
      results.set(row.hash, result);
      analyzerEvent(context, row, result);
      console.log(`${prefix}: TERMINAL — ${currentStatus}`);
    } else {
      const result = { ok: false, category: 'present_not_ready', detail: currentStatus, action: 'preserved active entry' };
      results.set(row.hash, result);
      analyzerEvent(context, row, result);
      console.log(`${prefix}: NOT READY — ${currentStatus}`);
    }
  }

  retryQueue = retryQueue.filter(row => {
    const category = results.get(row.hash)?.category;
    return category === 'touch_hoster_unavailable'
      || category === 'direct_probe_failed'
      || category === 'downloaded_without_links'
      || category === 'torrent_info_failed';
  });
  if (retryQueue.length && args.sweepWaitSeconds) {
    console.log(`Waiting ${args.sweepWaitSeconds} seconds before the second fresh-link sweep...`);
    await sleep(args.sweepWaitSeconds * 1_000);
  }
  for (let position = 0; position < retryQueue.length; position += 1) {
    const row = retryQueue[position];
    const candidates = index.get(row.hash) || [];
    let result;
    try {
      const info = candidates[0]?.id ? await client.info(candidates[0].id) : candidates[0];
      result = info ? await touchInfo(client, info, row.codes)
        : { ok: false, category: 'missing_from_rd', detail: 'hash disappeared before second sweep' };
    } catch (error) {
      result = { ok: false, category: 'torrent_info_failed', detail: error.code || 'torrent info failed' };
    }
    result.action = result.ok ? 'second fresh-link sweep' : 'queue exact-hash clone';
    results.set(row.hash, result);
    if (result.ok) {
      markCompleted(context.checkpointPath, row.hash, context.completed);
      analyzerEvent(context, row, result);
      console.log(`[retry ${position + 1}/${retryQueue.length}] ${row.codes}: RECOVERED`);
    } else {
      console.log(`[retry ${position + 1}/${retryQueue.length}] ${row.codes}: ${result.category.toUpperCase()}`);
    }
  }

  if (args.clone) {
    const cloneQueue = context.cases.filter(row => {
      const category = results.get(row.hash)?.category;
      return category === 'touch_hoster_unavailable'
        || category === 'direct_probe_failed'
        || category === 'downloaded_without_links'
        || category === 'torrent_info_failed'
        || category === 'missing_from_rd';
    });
    for (let position = 0; position < cloneQueue.length; position += 1) {
      const row = cloneQueue[position];
      let result;
      try {
        result = await repairExactHashClone(client, row);
      } catch (error) {
        result = { ok: false, category: 'clone_api_error', detail: error.code || 'clone request failed' };
      }
      result.action = result.ok ? 'non-destructive exact-hash clone and probe' : 'preserved original and clone';
      results.set(row.hash, result);
      if (result.ok) markCompleted(context.checkpointPath, row.hash, context.completed);
      analyzerEvent(context, row, result);
      console.log(`[clone ${position + 1}/${cloneQueue.length}] ${row.codes}: ${result.ok ? 'RECOVERED' : result.category.toUpperCase()}`);
    }
  }

  for (const row of context.cases) {
    if (!results.has(row.hash)) continue;
    const result = results.get(row.hash);
    if (!result.ok && !args.clone && !['present_not_ready', 'terminal_needs_tournament'].includes(result.category)) {
      analyzerEvent(context, row, result);
    }
  }
  const finalCases = context.cases.map(row => ({ ...publicCase(row), ...(results.get(row.hash) || {
    ok: false, category: 'not_processed', detail: '', action: '',
  }) }));
  const finalGroups = groupCases(finalCases, 'category');
  for (const [category, rows] of Object.entries(finalGroups)) {
    writeJsonPrivate(path.join(analysisOutput.categoriesDirectory, `final-${category}.json`), rows);
  }
  const final = {
    finishedAt: new Date().toISOString(),
    week: context.summary.week,
    reportSha256: context.reportSha256,
    attempted: context.cases.length,
    recovered: finalCases.filter(row => row.ok).length,
    unresolved: finalCases.filter(row => !row.ok).length,
    completedHashesThisWeek: context.completed.size,
    categories: Object.fromEntries(Object.entries(finalGroups).map(([key, rows]) => [key, rows.length])),
    cases: finalCases,
  };
  writeJsonPrivate(path.join(analysisOutput.directory, 'final-analysis.json'), final);
  return final;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const context = loadFailureCases(args);
  const analysisOutput = createAnalysisDirectory(context);
  console.log('');
  console.log('OPN RD Weekly Failure Analyzer');
  console.log(`Week:              ${context.summary.week}`);
  console.log(`Audited codes:     ${context.summary.verifiedCodes}`);
  console.log(`Unique hashes:     ${context.summary.targetHashes}`);
  console.log(`Completed hashes:  ${context.completed.size}`);
  console.log(`Unresolved hashes: ${context.cases.length}`);
  for (const [category, count] of Object.entries(analysisOutput.analysis.categories)) {
    console.log(`  ${category}: ${count}`);
  }
  console.log(`Analysis: ${analysisOutput.directory}`);
  if (args.analyzeOnly || !context.cases.length) {
    console.log(context.cases.length ? 'ANALYSIS COMPLETE; NO RD CHANGE WAS MADE' : 'NO UNRESOLVED HASHES');
    return 0;
  }
  if (!args.assumeYes) {
    console.log('');
    console.log('Disconnect any VPN before continuing. The analyzer never deletes RD entries.');
    console.log('It retries fresh links first and preserves every original while exact-hash clones are tested.');
    if (!await confirmRepair(context.cases, args.clone)) {
      console.log('Cancelled after analysis. No RD change was made.');
      return 0;
    }
  }
  fs.mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(context);
  const stop = () => {
    releaseLock();
    console.error('\nStopped safely. Run the same analyzer again to resume unresolved hashes.');
    process.exit(130);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const final = await runRepair(context, analysisOutput, args);
    console.log('');
    console.log('==================================================');
    console.log('OPN ANALYZER FINISHED');
    console.log('==================================================');
    console.log(`Recovered now:      ${final.recovered}`);
    console.log(`Still unresolved:   ${final.unresolved}`);
    for (const [category, count] of Object.entries(final.categories)) {
      console.log(`  ${category}: ${count}`);
    }
    console.log(`Final report: ${path.join(analysisOutput.directory, 'final-analysis.json')}`);
    return final.unresolved ? 2 : 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    releaseLock();
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  RdError,
  classifyHistorical,
  chooseVideoFileIds,
  groupCases,
  loadFailureCases,
  normalizedHash,
  parseArgs,
  publicCase,
  selectedVideoLinks,
  torrentIndex,
};
