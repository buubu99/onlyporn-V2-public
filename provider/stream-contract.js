'use strict';

const PLAYABLE_EXTENSION = /\.(?:m3u8|m4v|mkv|mp4|ts|webm)$/i;

function cleanFilename(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function filenameFromUrl(value) {
  try {
    const pathname = decodeURIComponent(new URL(String(value)).pathname);
    const name = pathname.split('/').filter(Boolean).pop() || '';
    return PLAYABLE_EXTENSION.test(name) ? cleanFilename(name) : '';
  } catch {
    return '';
  }
}

function fallbackFilename(stream, index) {
  const label = cleanFilename(stream?.title || stream?.name || `OnlyPorn stream ${index + 1}`);
  let extension = '.mp4';
  try {
    if (/\.m3u8(?:$|[/?#])/i.test(new URL(String(stream?.url || '')).pathname)) {
      extension = '.m3u8';
    }
  } catch {}
  return PLAYABLE_EXTENSION.test(label) ? label : `${label || 'OnlyPorn stream'}${extension}`;
}

function playbackTargetCount(stream = {}) {
  return ['url', 'infoHash', 'ytId', 'externalUrl']
    .filter(key => String(stream?.[key] || '').trim()).length;
}

function normalizeStreamResponse(response = {}) {
  const streams = Array.isArray(response?.streams) ? response.streams : [];
  return {
    ...(response || {}),
    streams: streams
      .filter(stream => stream && typeof stream === 'object' && playbackTargetCount(stream) === 1)
      .map((stream, index) => {
        if (!stream.url && !stream.infoHash) return stream;
        const behaviorHints = { ...(stream.behaviorHints || {}) };
        if (!String(behaviorHints.filename || '').trim()) {
          behaviorHints.filename =
            filenameFromUrl(stream.url) ||
            fallbackFilename(stream, index);
        }
        return { ...stream, behaviorHints };
      }),
  };
}

module.exports = {
  cleanFilename,
  filenameFromUrl,
  normalizeStreamResponse,
  playbackTargetCount,
};
