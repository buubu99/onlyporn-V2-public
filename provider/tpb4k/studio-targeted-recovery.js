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
module.exports = { existingCandidateCounts, profile, recoverStudioPlayback };
