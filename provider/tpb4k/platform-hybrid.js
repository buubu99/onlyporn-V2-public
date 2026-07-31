'use strict';

function prefix(value) {
  return String(value || '').split(':', 1)[0].toLowerCase();
}

function createPlatformHybridAdapter(options = {}) {
  const metadataAdapter = options.metadataAdapter;
  const torrentAdapter = options.torrentAdapter;
  if (!metadataAdapter || !torrentAdapter) {
    throw new Error('platform-hybrid requires metadata and torrent adapters');
  }
  let lastDiagnostics = Object.freeze({});

  async function catalog({ catalog, skip = 0, limit = 40 }) {
    const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), maximumLimit);
    const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const metadata = await metadataAdapter.catalog({ catalog, skip: safeSkip, limit: safeLimit });
    const output = [...metadata];
    let torrent = [];
    if (catalog?.playbackBindingPool) {
      lastDiagnostics = Object.freeze({
        platformHybrid: Object.freeze({
          metadataRecords: metadata.length,
          torrentFallbackRecords: 0,
          returned: metadata.length,
          playbackBindingPool: true,
        }),
        ...(metadataAdapter.diagnostics?.() || {}),
      });
      return output;
    }
    if (output.length < safeLimit) {
      torrent = await torrentAdapter.catalog({
        catalog: { ...catalog, source: 'torrent-index' },
        skip: safeSkip,
        limit: safeLimit - output.length,
      });
      const seen = new Set(output.map(item => String(item.sourceId || '')));
      for (const item of torrent) {
        if (seen.has(String(item.sourceId || ''))) continue;
        seen.add(String(item.sourceId || ''));
        output.push(item);
        if (output.length >= safeLimit) break;
      }
    }
    lastDiagnostics = Object.freeze({
      platformHybrid: Object.freeze({
        metadataRecords: metadata.length,
        torrentFallbackRecords: torrent.length,
        returned: output.length,
      }),
      ...(metadataAdapter.diagnostics?.() || {}),
      ...(torrentAdapter.diagnostics?.() || {}),
    });
    return output;
  }

  async function meta(args = {}) {
    const provider = prefix(args.sourceId);
    if (provider === 'tpdb' || provider === 'stashdb') return metadataAdapter.meta(args);
    return torrentAdapter.meta(args);
  }

  return Object.freeze({
    id: 'platform-hybrid',
    configured: metadataAdapter.configured || torrentAdapter.configured,
    catalog,
    meta,
    async resolve(args = {}) {
      return torrentAdapter.resolve(args);
    },
    diagnostics() {
      return lastDiagnostics;
    },
  });
}

module.exports = { createPlatformHybridAdapter };
