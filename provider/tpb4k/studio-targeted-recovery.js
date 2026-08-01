'use strict';

const { bindStudioPlayback, validInfoHash } = require('./studio-playback-binding');

function compact(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
function key(value) { return compact(value).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function profile(catalog = {}) {
  const studio = key(catalog.studio);
  if (studio === 'onlyfans') return Object.freeze({ maxTargets: 15, minimumCards: 8, desiredCandidates: 2, concurrency: 3, targetTimeoutMs: 6_500, totalBudgetMs: 22_000 });
  if (studio === 'digitalplayground' || studio === 'xvideosred') return Object.freeze({ maxTargets: 15, minimumCards: 8, desiredCandidates: 2, concurrency: 3, targetTimeoutMs: 6_500, totalBudgetMs: 22_000 });
  if (studio === 'sexmex') return Object.freeze({ maxTargets: 10, minimumCards: 8, desiredCandidates: 3, concurrency: 3, targetTimeoutMs: 6_000, totalBudgetMs: 18_000 });
  return Object.freeze({ maxTargets: 6, minimumCards: 1, desiredCandidates: 2, concurrency: 3, targetTimeoutMs: 5_000, totalBudgetMs: 12_000 });
}
function timeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve([]), Math.max(milliseconds, 100)); }),
  ]);
}
async function mapLimited(values, limit, mapper) {
  if (!values.length) return [];
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next; next += 1;
      try { output[index] = await mapper(values[index], index); } catch { output[index] = []; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), values.length) }, () => worker()));
  return output;
}
function existingCandidateCounts(binding) {
  return new Map((binding?.items || []).map(item => [String(item.sourceId), Array.isArray(item.playbackCandidates) ? item.playbackCandidates.length : (item.infoHash ? 1 : 0)]));
}
function normalizeRecovered(values, metadata, minimumSeeders = 0) {
  const output = []; const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const infoHash = validInfoHash(value?.infoHash);
    const fileIdx = Number.isInteger(value?.fileIdx) && value.fileIdx >= 0 ? value.fileIdx : null;
    const identity = `${infoHash}:${fileIdx ?? ''}`;
    const seeders = Math.max(Number.parseInt(String(value?.seeders ?? 0), 10) || 0, 0);
    if (!infoHash || seeders < minimumSeeders || seen.has(identity)) continue;
    seen.add(identity);
    output.push(Object.freeze({
      ...value, infoHash, seeders,
      targetSourceId: String(metadata.sourceId),
      studio: value.studio || metadata.studio,
      performers: Array.isArray(value.performers) && value.performers.length ? value.performers : metadata.performers,
      creator: value.creator || metadata.creator,
      username: value.username || metadata.username,
      channel: value.channel || metadata.channel,
      account: value.account || metadata.account,
      releaseDate: value.releaseDate || metadata.releaseDate,
      sceneCode: value.sceneCode || metadata.sceneCode,
      sourceId: value.sourceId || `targeted:${infoHash}`,
      indexer: value.indexer || value.source || 'torrent-index',
    }));
  }
  return output;
}
async function recoverStudioPlayback(options = {}) {
  const catalog = options.catalog || {};
  const metadataItems = Array.isArray(options.metadataItems) ? options.metadataItems : [];
  const torrentItems = Array.isArray(options.torrentItems) ? options.torrentItems : [];
  const resolver = options.resolverAdapter;
  const settings = profile(catalog);
  const normalizedLimit = Math.min(Math.max(Number.parseInt(String(options.limit || settings.minimumCards), 10) || settings.minimumCards, 1), Math.max(metadataItems.length, 1));
  const recoveryCardTarget = Math.min(metadataItems.length, Math.max(settings.minimumCards, Math.min(normalizedLimit, settings.maxTargets)));
  let workingTorrents = [...torrentItems];
  let binding = bindStudioPlayback({ catalog, metadataItems, torrentItems: workingTorrents, skip: 0, limit: Math.max(metadataItems.length, 1) });
  if (binding.items.length >= recoveryCardTarget || !resolver || typeof resolver.resolve !== 'function') {
    const final = bindStudioPlayback({ catalog, metadataItems, torrentItems: workingTorrents, skip: options.skip, limit: options.limit });
    return Object.freeze({ ...final, recovery: Object.freeze({ attempted: 0, completed: 0, recoveredCandidates: 0, timedOut: 0, profile: settings, finalCards: final.items.length, finalCandidates: final.stats.boundCandidates }) });
  }
  const initiallyBound = new Set(binding.items.map(item => String(item.sourceId)));
  const targets = metadataItems.filter(item => !initiallyBound.has(String(item.sourceId))).slice(0, settings.maxTargets);
  const deadlineAt = Date.now() + settings.totalBudgetMs;
  let attempted = 0; let completed = 0; let timedOut = 0; let recoveredCandidates = 0;
  for (let offset = 0; offset < targets.length && binding.items.length < recoveryCardTarget; offset += settings.concurrency) {
    if (deadlineAt - Date.now() <= 100) break;
    const batch = targets.slice(offset, offset + settings.concurrency);
    attempted += batch.length;
    const resolved = await mapLimited(batch, settings.concurrency, async metadata => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 100) { timedOut += 1; return []; }
      const duration = Math.min(settings.targetTimeoutMs, remaining);
      const started = Date.now();
      const values = await timeout(resolver.resolve({
        sourceId: String(metadata.sourceId), catalogId: String(catalog.id || ''),
        catalog: { ...catalog, targetedPlaybackSearch: true }, item: metadata, config: options.config,
      }), duration);
      if (Date.now() - started >= duration - 20 && !(Array.isArray(values) && values.length)) timedOut += 1;
      completed += 1;
      return normalizeRecovered(values, metadata, Math.max(Number(options.config?.minimumSeeders || 0), 0));
    });
    const recovered = resolved.flat();
    recoveredCandidates += recovered.length;
    workingTorrents.push(...recovered);
    binding = bindStudioPlayback({ catalog, metadataItems, torrentItems: workingTorrents, skip: 0, limit: Math.max(metadataItems.length, 1) });
  }
  const final = bindStudioPlayback({ catalog, metadataItems, torrentItems: workingTorrents, skip: options.skip, limit: options.limit });
  return Object.freeze({
    ...final,
    recovery: Object.freeze({ attempted, completed, recoveredCandidates, timedOut, profile: settings, finalCards: final.items.length, finalCandidates: final.stats.boundCandidates }),
  });
}

function bundleCandidate(value = {}) {
  const infoHash = validInfoHash(value.infoHash);
  if (!infoHash) return null;
  return Object.freeze({
    infoHash,
    title: compact(value.title || value.filename),
    filename: compact(value.filename || value.title),
    resolution: compact(value.resolution || value.quality),
    indexer: compact(value.indexer || value.source || 'torrent-index').toLowerCase(),
    seeders: Math.max(Number.parseInt(String(value.seeders ?? 0), 10) || 0, 0),
    size: value.size ?? 0,
    fileIdx: Number.isInteger(value.fileIdx) && value.fileIdx >= 0 ? value.fileIdx : null,
    playbackBinding: compact(value.playbackBinding || 'targeted-failover-candidate'),
    playbackScore: Number(value.playbackScore || 0),
    playbackSourceId: compact(value.playbackSourceId || value.sourceId),
  });
}
function mergeBundle(item = {}, recovered = [], desiredCandidates = 3) {
  const rows = Array.isArray(item.playbackCandidates) && item.playbackCandidates.length
    ? item.playbackCandidates : [item];
  const merged = [];
  const seen = new Set();
  for (const value of [...rows, ...recovered]) {
    const normalized = bundleCandidate(value);
    const key = normalized ? `${normalized.infoHash}:${normalized.fileIdx ?? ''}` : '';
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  const candidates = Object.freeze(merged.slice(0, Math.max(desiredCandidates, rows.length, 1)));
  const primary = candidates[0];
  return primary ? Object.freeze({
    ...item,
    infoHash: primary.infoHash,
    filename: primary.filename || item.filename || item.title,
    resolution: primary.resolution || item.resolution,
    indexer: primary.indexer || item.indexer,
    seeders: primary.seeders,
    size: primary.size,
    fileIdx: primary.fileIdx,
    playbackCandidates: candidates,
  }) : item;
}
async function augmentStudioPlayback(options = {}) {
  const catalog = options.catalog || {};
  const items = Array.isArray(options.items) ? options.items : [];
  const resolver = options.resolverAdapter;
  const settings = profile(catalog);
  if (!items.length || !resolver || typeof resolver.resolve !== 'function') {
    return Object.freeze({ items: Object.freeze([...items]), stats: Object.freeze({ attempted: 0, completed: 0, recoveredCandidates: 0, timedOut: 0, multiCandidateScenes: items.filter(item => item.playbackCandidates?.length > 1).length }) });
  }
  const targets = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.playbackCandidates?.length || (item.infoHash ? 1 : 0)) < settings.desiredCandidates)
    .slice(0, settings.maxTargets);
  const deadlineAt = Date.now() + settings.totalBudgetMs;
  let completed = 0;
  let timedOut = 0;
  let recoveredCandidates = 0;
  const recoveredByIndex = new Map();
  await mapLimited(targets, settings.concurrency, async ({ item, index }) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 100) { timedOut += 1; return []; }
    const duration = Math.min(settings.targetTimeoutMs, remaining);
    const started = Date.now();
    const values = await timeout(resolver.resolve({
      // Avoid the resolver's remembered single-hash fast path. Candidate
      // augmentation must run the title through Knaben, TPB and 1337x so
      // AIOStreams receives genuine alternatives when one RD hash is queued.
      sourceId: `catalog-failover:${String(item.sourceId || index)}`,
      catalogId: String(catalog.id || ''),
      catalog: { ...catalog, targetedPlaybackSearch: true },
      item,
      config: options.config,
    }), duration);
    if (Date.now() - started >= duration - 20 && !(Array.isArray(values) && values.length)) timedOut += 1;
    completed += 1;
    const recovered = normalizeRecovered(values, item, Math.max(Number(options.config?.minimumSeeders || 0), 0));
    recoveredCandidates += recovered.length;
    recoveredByIndex.set(index, recovered);
    return recovered;
  });
  const augmented = items.map((item, index) => mergeBundle(item, recoveredByIndex.get(index) || [], settings.desiredCandidates));
  return Object.freeze({
    items: Object.freeze(augmented),
    stats: Object.freeze({
      attempted: targets.length,
      completed,
      recoveredCandidates,
      timedOut,
      desiredCandidates: settings.desiredCandidates,
      multiCandidateScenes: augmented.filter(item => item.playbackCandidates?.length > 1).length,
    }),
  });
}
module.exports = { augmentStudioPlayback, existingCandidateCounts, profile, recoverStudioPlayback };
