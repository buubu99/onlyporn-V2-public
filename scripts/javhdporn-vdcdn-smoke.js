#!/usr/bin/env node
'use strict';

const createJavHdPorn = require('../provider/javhdporn');
const mediaRelay = require('../media-relay');

const TITLES = [
  'https://www.javhdporn.net/video/fc2-ppv-3854676/',
  'https://www.javhdporn.net/video/fc2-ppv-4730094/',
];

function firstUri(playlist) {
  return String(playlist)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#')) || '';
}

async function fetchBuffer(url, headers) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    body,
    contentType: response.headers.get('content-type') || '',
    finalUrl: response.url,
    status: response.status,
  };
}

async function inspectTitle(provider, pageUrl) {
  const label = new URL(pageUrl).pathname.split('/').filter(Boolean).at(-1);
  const started = Date.now();
  const html = await provider.fetchHtml(pageUrl, { cache: false });
  const bootstrap = provider.playerBootstrap(html);
  if (!bootstrap?.videoId || !bootstrap?.mpu) {
    throw new Error(`${label}: player bootstrap was incomplete`);
  }

  const decoded = await provider.requestPlayerSources(pageUrl, bootstrap);
  const media = await provider.discoverMedia(decoded, pageUrl);
  const candidate = media.find(item => {
    try {
      const host = new URL(item.url).hostname.toLowerCase();
      return host === 'vdcdn.xyz' || host.endsWith('.vdcdn.xyz');
    } catch {
      return false;
    }
  });
  if (!candidate) throw new Error(`${label}: no vdcdn candidate was decoded`);

  const headers = await provider.playbackHeaders(candidate.referer, candidate.url);
  const master = await fetchBuffer(candidate.url, headers);
  const masterText = master.body.toString('utf8');
  if (!masterText.includes('#EXTM3U') || !masterText.includes('#EXT-X-STREAM-INF')) {
    throw new Error(`${label}: master playlist was invalid`);
  }
  const variantUri = firstUri(masterText);
  if (!variantUri) throw new Error(`${label}: master had no variant URI`);
  const variantUrl = new URL(variantUri, master.finalUrl).toString();

  const variant = await fetchBuffer(variantUrl, headers);
  const variantText = variant.body.toString('utf8');
  if (!variantText.includes('#EXTM3U') || !variantText.includes('#EXTINF')) {
    throw new Error(`${label}: variant playlist was invalid`);
  }
  const segmentUri = firstUri(variantText);
  if (!segmentUri) throw new Error(`${label}: variant had no segment URI`);
  const segmentUrl = new URL(segmentUri, variant.finalUrl).toString();

  const segment = await fetchBuffer(segmentUrl, headers);
  const normalized = mediaRelay._test.normalizeJavTransportSegment(segment.body);
  if (!normalized) throw new Error(`${label}: segment was not MPEG-TS`);

  const relayStream = await provider.streamFromMedia(candidate);
  if (!relayStream?.url?.startsWith('https://onlyporn-smoke.invalid/media/')) {
    throw new Error(`${label}: protected relay registration failed`);
  }

  console.log(JSON.stringify({
    title: label,
    decodedCandidates: decoded.length,
    mediaCandidates: media.length,
    host: new URL(candidate.url).hostname,
    masterStatus: master.status,
    variantStatus: variant.status,
    segmentStatus: segment.status,
    segmentName: new URL(segmentUrl).pathname.split('/').at(-1),
    upstreamContentType: segment.contentType,
    wrapperBytes: normalized.wrapperBytes,
    payloadBytes: normalized.payload.length,
    relayRegistered: true,
    elapsedMs: Date.now() - started,
  }));
}

async function main() {
  mediaRelay.setPublicBase('https://onlyporn-smoke.invalid');
  const provider = createJavHdPorn();
  for (const title of TITLES) {
    await inspectTitle(provider, title);
  }
  console.log('JAVHDPorn vdcdn live smoke passed for 2 titles.');
}

main().catch(error => {
  console.error(`JAVHDPorn vdcdn live smoke failed: ${error.message}`);
  process.exit(1);
});
