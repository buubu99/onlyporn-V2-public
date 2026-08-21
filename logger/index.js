const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const pino = require('pino');
const packageInfo = require('../package.json');

const enabled = !/^(?:0|false|off|no)$/i.test(String(process.env.LOG_ENABLED ?? 'true'));
const defaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
const level = String(process.env.LOG_LEVEL || defaultLevel).toLowerCase();
const requestContext = new AsyncLocalStorage();

function shortHash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function cleanCommit(value) {
  const match = String(value || '').toLowerCase().match(/[a-f0-9]{7,40}/);
  return match ? match[0] : 'unknown';
}

function compactIdentifier(value, maxLength = 160) {
  const normalized = String(value || '').trim();
  if (!normalized) return { value: '', hash: '', length: 0, truncated: false };
  if (normalized.length <= maxLength) {
    return {
      value: normalized,
      hash: shortHash(normalized),
      length: normalized.length,
      truncated: false,
    };
  }
  return {
    value: `${normalized.slice(0, 72)}...[sha256:${shortHash(normalized)}]`,
    hash: shortHash(normalized),
    length: normalized.length,
    truncated: true,
  };
}

function classifyClient(userAgentValue = '') {
  const userAgent = String(userAgentValue || '');
  const lower = userAgent.toLowerCase();
  let platform = 'unknown';
  let uaFamily = 'unknown';

  if (lower.includes('dalvik') && lower.includes('android')) {
    platform = /tv|google tv|chromecast|atv/.test(lower) ? 'android-tv' : 'android';
    uaFamily = 'dalvik';
  } else if (lower.includes('stremio') && lower.includes('android')) {
    platform = /tv|google tv|chromecast|atv/.test(lower) ? 'android-tv' : 'android';
    uaFamily = 'stremio-android';
  } else if (lower.includes('node-fetch')) {
    platform = 'server';
    uaFamily = 'node-fetch';
  } else if (lower.includes('curl')) {
    platform = 'server';
    uaFamily = 'curl';
  } else if (lower.includes('macintosh') && lower.includes('chrome/')) {
    platform = 'mac-web';
    uaFamily = 'chrome';
  } else if (lower.includes('macintosh') && lower.includes('safari/')) {
    platform = 'mac-web';
    uaFamily = 'safari';
  } else if (lower.includes('windows') && lower.includes('chrome/')) {
    platform = 'windows-web';
    uaFamily = 'chrome';
  } else if (lower.includes('android')) {
    platform = /tv|google tv|chromecast|atv/.test(lower) ? 'android-tv' : 'android';
    uaFamily = lower.includes('chrome/') ? 'chrome' : 'android';
  } else if (lower.includes('iphone') || lower.includes('ipad')) {
    platform = 'ios';
    uaFamily = lower.includes('crios') ? 'chrome' : 'safari';
  }

  return {
    platform,
    uaFamily,
    uaHash: userAgent ? shortHash(userAgent, 12) : '',
  };
}

function requestIdFrom(req) {
  const supplied = String(req?.headers?.['x-onlyporn-request-id'] || '').trim();
  if (/^[a-zA-Z0-9._:-]{1,96}$/.test(supplied)) return supplied;
  return `op-${crypto.randomBytes(8).toString('hex')}`;
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function routeMetadata(req) {
  const path = String(req?.path || req?.url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  const first = String(parts[0] || '').toLowerCase();
  let resource = 'http';
  let mediaType = '';
  let target = '';
  let search = '';
  let skip = '';

  if (['catalog', 'stream', 'meta'].includes(first)) {
    resource = first;
    mediaType = decodePathPart(parts[1]);
    target = decodePathPart(parts[2]).replace(/\.json$/i, '');
    const extra = decodePathPart(parts.slice(3).join('/')).replace(/\.json$/i, '');
    if (extra) {
      const params = new URLSearchParams(extra);
      search = String(params.get('search') || '').slice(0, 200);
      skip = String(params.get('skip') || '').slice(0, 20);
    }
  } else if (first === 'media') {
    resource = 'media';
    target = 'protected-relay';
  } else if (path === '/manifest.json') {
    resource = 'manifest';
    target = 'manifest';
  } else if (/\/(?:ready|healthz?|status)(?:\/|$)/i.test(path)) {
    resource = 'health';
    target = 'readiness';
  } else if (/\/poster\//i.test(path) || /\/image\//i.test(path)) {
    resource = 'poster';
    target = 'image-proxy';
  }

  const compact = compactIdentifier(target);
  return {
    resource,
    mediaType,
    targetId: compact.value,
    targetHash: compact.hash,
    targetLength: compact.length,
    targetTruncated: compact.truncated,
    ...(resource === 'http'
      ? {
          routeKey: /^[a-z0-9._-]{1,48}$/.test(first) ? first : (first ? 'other' : 'root'),
          pathHash: shortHash(path || '/', 12),
        }
      : {}),
    ...(search ? { search } : {}),
    ...(skip ? { skip } : {}),
  };
}

function createRequestContext(req) {
  return {
    rid: requestIdFrom(req),
    ...routeMetadata(req),
    ...classifyClient(req?.headers?.['user-agent']),
  };
}

function currentTraceContext() {
  return requestContext.getStore() || {};
}

function runWithTraceContext(context, callback) {
  return requestContext.run(Object.freeze({ ...(context || {}) }), callback);
}

function safeUrlLogValue(value) {
  const normalized = String(value || '');
  if (/^[a-zA-Z0-9_.:-]{1,160}$/.test(normalized) && !normalized.includes('://')) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    const extension = parsed.pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0]?.toLowerCase() || '';
    return {
      hostname: parsed.hostname,
      extension,
      pathHash: shortHash(parsed.pathname, 12),
      hasQuery: Boolean(parsed.search),
    };
  } catch {
    return normalized ? { valueHash: shortHash(normalized, 12) } : '';
  }
}

function safeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization|cookie|token|secret|api[-_]?key/i.test(key)) result[key] = '[Redacted]';
    else result[key] = value;
  }
  return result;
}

const git = cleanCommit(
  process.env.ONLYPORN_MEDIA_GENERATION ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.SOURCE_COMMIT
);

const logger = pino({
  level,
  base: {
    pid: undefined,
    hostname: undefined,
    service: 'onlyporn-v2',
    build: packageInfo.version,
    git,
  },
  enabled,
  mixin() {
    // Pino merges the per-call fields into this object in place. Always return
    // a mutable copy so the frozen AsyncLocalStorage context cannot make
    // logging capable of breaking an application request.
    return { ...currentTraceContext() };
  },
  serializers: {
    url: safeUrlLogValue,
    pageUrl: safeUrlLogValue,
    subtitleUrl: safeUrlLogValue,
    canonicalUrl: safeUrlLogValue,
    sourceId: safeUrlLogValue,
    headers: safeHeaders,
  },
  redact: {
    paths: [
      'authorization',
      'cookie',
      'token',
      'accessToken',
      'apiKey',
      'password',
      'headers.authorization',
      'headers.Authorization',
      'headers.cookie',
      'headers.Cookie',
    ],
    censor: '[Redacted]',
  },
});

logger.createRequestContext = createRequestContext;
logger.currentTraceContext = currentTraceContext;
logger.runWithTraceContext = runWithTraceContext;
logger.compactIdentifier = compactIdentifier;
logger._traceTest = {
  classifyClient,
  compactIdentifier,
  routeMetadata,
  safeHeaders,
  safeUrlLogValue,
};

module.exports = logger;
