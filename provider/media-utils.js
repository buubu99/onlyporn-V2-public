const PREVIEW_TOKEN_RE =
  /(?:^|[\/._-])(?:thumb|thumbs|thumbnail|thumbnails|preview|previews|trailer|trailers|teaser|teasers|sprite|sprites|storyboard|storyboards|sample|samples)(?:[\/._-]|$)/i;

const RESOLUTION_RE =
  /(?:^|[^0-9])(144|240|360|480|540|576|720|1080|1440|2160|4320)p(?:[^0-9]|$)/i;

function cleanMediaUrl(value) {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/["'\\]+$/g, '');
}

function isPreviewMediaUrl(value) {
  const url = cleanMediaUrl(value);
  if (!url) return true;

  const lower = url.toLowerCase();
  if (/\.t\.mp4(?:[?#]|$)/i.test(lower)) return true;
  if (PREVIEW_TOKEN_RE.test(lower)) return true;
  if (/videos_screenshots|screenshots|thumb-cdn|thumbs?-cdn|thumb-v\d/i.test(lower)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    if (host.startsWith('thumb-') || host.includes('.thumb.')) return true;
    if (PREVIEW_TOKEN_RE.test(path)) return true;
  } catch (_) {
    // Relative URLs are evaluated using their raw string above.
  }

  return false;
}

function extractResolution(...values) {
  const text = values.filter(Boolean).join(' ');
  if (/\b(?:4k|uhd)\b/i.test(text)) return '2160p';
  if (/\b2k\b/i.test(text)) return '1440p';

  const match = text.match(RESOLUTION_RE);
  return match ? `${match[1]}p` : null;
}

function isDirectMp4(value) {
  const url = cleanMediaUrl(value);
  return /\.mp4(?:[?#]|$)/i.test(url) && !/\.mp4\.m3u8(?:[?#]|$)/i.test(url);
}

function isHls(value) {
  return /\.m3u8(?:[?#]|$)/i.test(cleanMediaUrl(value));
}

function isPlayableMediaUrl(value) {
  return isDirectMp4(value) || isHls(value);
}

function isLikelyFullVideoMp4(value, options = {}) {
  const url = cleanMediaUrl(value);
  if (!isDirectMp4(url) || isPreviewMediaUrl(url)) return false;

  if (extractResolution(url)) return true;

  const lower = url.toLowerCase();
  const knownVideoPath =
    /\/(?:contents\/videos|videos?|media|files|uploads|download)\//i.test(lower);

  return Boolean(options.allowKnownVideoPath && knownVideoPath);
}

module.exports = {
  cleanMediaUrl,
  extractResolution,
  isDirectMp4,
  isHls,
  isLikelyFullVideoMp4,
  isPlayableMediaUrl,
  isPreviewMediaUrl,
};
