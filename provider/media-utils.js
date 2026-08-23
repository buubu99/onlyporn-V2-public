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

function normalizeAbsoluteUrl(value, baseUrl) {
  const cleaned = cleanMediaUrl(value);
  if (!cleaned) return '';

  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return '';
  }
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
    const path = decodeURIComponent(parsed.pathname).toLowerCase();

    if (host.startsWith('thumb-') || host.includes('.thumb.')) return true;
    if (PREVIEW_TOKEN_RE.test(path)) return true;
  } catch (_) {
    // Relative URLs are evaluated using their raw string above.
  }

  return false;
}

function isPreviewMediaCandidate(value, context = '') {
  return isPreviewMediaUrl(value) || PREVIEW_TOKEN_RE.test(String(context || ''));
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
  const context = String(options.context || '');

  if (!isDirectMp4(url) || isPreviewMediaCandidate(url, context)) return false;

  if (extractResolution(context, url)) return true;

  const lower = url.toLowerCase();
  const knownVideoPath =
    /\/(?:contents\/videos|videos?|media|files|uploads|download)\//i.test(lower);
  const knownGenericVideoBasename =
    /\/mp4_(?:sd|hd|uhd|low|high)\.mp4(?:[?#]|$)/i.test(lower);

  return Boolean(
    options.allowKnownVideoPath &&
      (knownVideoPath || (options.allowGenericVideoBasename && knownGenericVideoBasename))
  );
}

function resolutionNumber(value) {
  const resolution = extractResolution(value);
  return resolution ? Number.parseInt(resolution, 10) || 0 : 0;
}

function selectDirectMp4Candidates(candidates, options = {}) {
  const {
    baseUrl,
    allowKnownVideoPath = true,
    allowGenericVideoBasename = false,
    requireResolution = false,
  } = options;

  const byKey = new Map();

  for (const rawCandidate of candidates || []) {
    const candidate = typeof rawCandidate === 'string'
      ? { url: rawCandidate }
      : rawCandidate || {};
    const url = normalizeAbsoluteUrl(candidate.url, baseUrl);
    const context = [candidate.label, candidate.context].filter(Boolean).join(' ');

    if (!url) continue;
    if (!isLikelyFullVideoMp4(url, {
      allowKnownVideoPath,
      allowGenericVideoBasename,
      context,
    })) continue;

    const resolution = extractResolution(context, url);
    if (requireResolution && !resolution) continue;

    const priority = Number.isFinite(candidate.priority) ? candidate.priority : 100;
    const key = resolution || url;
    const existing = byKey.get(key);

    if (!existing || priority < existing.priority) {
      byKey.set(key, {
        url,
        resolution,
        priority,
        label: candidate.label || null,
      });
    }
  }

  return [...byKey.values()]
    .sort((left, right) => {
      const resolutionDelta = resolutionNumber(right.resolution) - resolutionNumber(left.resolution);
      return resolutionDelta || left.priority - right.priority || left.url.localeCompare(right.url);
    });
}

module.exports = {
  cleanMediaUrl,
  extractResolution,
  isDirectMp4,
  isHls,
  isLikelyFullVideoMp4,
  isPlayableMediaUrl,
  isPreviewMediaCandidate,
  isPreviewMediaUrl,
  normalizeAbsoluteUrl,
  selectDirectMp4Candidates,
};
