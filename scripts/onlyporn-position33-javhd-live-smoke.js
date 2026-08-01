#!/usr/bin/env node
'use strict';

const axios = require('axios');
const mediaRelay = require('../media-relay');
const createJavHdPorn = require('../provider/javhdporn');

mediaRelay.setPublicBase('https://onlyporn-local-test.invalid');

const TITLES = Object.freeze([
  ['NIMA-038', 'https://www.javhdporn.net/video/nima-038-decensored/'],
  ['MEYD-985', 'https://www.javhdporn.net/video/meyd-985/'],
  ['NGOD-298', 'https://www.javhdporn.net/video/ngod-298/'],
  ['PPPE-138', 'https://www.javhdporn.net/video/pppe-138/'],
]);

function hostname(value) {
  try { return new URL(value).hostname.toLowerCase(); }
  catch { return 'invalid'; }
}

async function fetchPlaylist(candidate, provider) {
  const headers = await provider.playbackHeaders(candidate.referer, candidate.url);
  const response = await axios.get(candidate.url, {
    headers,
    maxRedirects: 5,
    timeout: 30_000,
    responseType: 'text',
    validateStatus: () => true,
    maxContentLength: 4 * 1024 * 1024,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`playlist HTTP ${response.status}`);
  }

  const content = String(response.data || '');
  if (!content.includes('#EXTM3U')) {
    throw new Error('response was not HLS');
  }

  const finalUrl =
    response.request?.res?.responseUrl ||
    response.config?.url ||
    candidate.url;

  mediaRelay._test.rewritePlaylist(content, finalUrl, {
    url: candidate.url,
    headers,
    provider: 'javhdporn',
    kind: 'hls',
  });

  return hostname(finalUrl);
}

async function inspectTitle(code, url) {
  const provider = createJavHdPorn();
  const html = await provider.fetchHtml(url, { cache: false });
  const bootstrap = provider.playerBootstrap(html);

  if (!bootstrap.videoId || !bootstrap.mpu) {
    throw new Error(`${code}: player bootstrap missing`);
  }

  const decoded = await provider.requestPlayerSources(url, bootstrap);
  const media = await provider.discoverMedia(decoded, url);

  const approved = [];
  for (const candidate of media) {
    try {
      mediaRelay._test.validateTargetUrl(candidate.url, 'javhdporn');
      approved.push(candidate);
    } catch {
      // Expected fail-closed behavior for unverified decoys.
    }
  }

  const discoveredHosts = [...new Set(approved.map(item => hostname(item.url)))];
  const verifiedHosts = [];
  const errors = [];

  for (const candidate of approved) {
    if (candidate.kind !== 'hls') continue;
    try {
      verifiedHosts.push(await fetchPlaylist(candidate, provider));
    } catch (error) {
      errors.push(`${hostname(candidate.url)}:${error.message}`);
    }
  }

  const uniqueVerified = [...new Set(verifiedHosts)];
  console.log(
    `${code}: decoded=${decoded.length} media=${media.length} ` +
    `approved=${approved.length} discovered=[${discoveredHosts.join(',') || 'none'}] ` +
    `playlistVerified=[${uniqueVerified.join(',') || 'none'}]`
  );

  if (!approved.length) {
    throw new Error(`${code}: zero approved media candidates`);
  }
  if (!uniqueVerified.length) {
    throw new Error(
      `${code}: no HLS playlist passed fetch+rewrite; ${errors.join(' | ') || 'no HLS candidates'}`
    );
  }
}

(async () => {
  for (const [code, url] of TITLES) {
    await inspectTitle(code, url);
  }
  console.log('LIVE JAVHDPorn ACCEPTANCE PASSED FOR ALL FOUR TITLES');
  process.exit(0);
})().catch(error => {
  console.error(`POSITION33_JAVHD_LIVE_FAIL: ${error.message}`);
  process.exit(1);
});
