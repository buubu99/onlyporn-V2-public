#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2] || 'local';
const target = String(
  process.argv[3] ||
  process.env.ONLYPORN_LIVE_URL ||
  'https://onlyporn-v2-public-k143.onrender.com'
).replace(/\/+$/, '');

const expectedMinimumCards = Math.max(
  Number.parseInt(process.env.EXPECTED_MIN_CARDS || '1', 10) || 1,
  1
);

const maximumFailures = Math.max(
  Number.parseInt(process.env.MAX_FAILURES || '1', 10) || 0,
  0
);

const reportPath =
  process.env.YESPORN_REPORT ||
  path.join(process.cwd(), `yesporn-${mode}-report.json`);

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readBounded(response, maximum = 65_536) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.subarray(0, maximum);
  }

  const chunks = [];
  let total = 0;

  try {
    while (total < maximum) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = maximum - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort.
    }
  }

  return Buffer.concat(chunks, total);
}

function proxyRequestHeaders(stream = {}) {
  const input = stream.behaviorHints?.proxyHeaders?.request;
  return input && typeof input === 'object' ? input : {};
}

async function validateMediaStream(stream) {
  let url;
  try {
    url = new URL(String(stream?.url || ''));
  } catch {
    return {
      success: false,
      error: 'invalid or missing stream URL',
    };
  }

  if (url.protocol !== 'https:') {
    return {
      success: false,
      error: 'stream URL is not HTTPS',
    };
  }

  const headers = proxyRequestHeaders(stream);
  if (!String(headers['User-Agent'] || '').trim()) {
    return {
      success: false,
      error: 'missing proxy User-Agent',
    };
  }

  let referer;
  try {
    referer = new URL(String(headers.Referer || ''));
  } catch {
    return {
      success: false,
      error: 'missing or invalid proxy Referer',
    };
  }

  if (referer.protocol !== 'https:') {
    return {
      success: false,
      error: 'proxy Referer is not HTTPS',
    };
  }

  if (stream.behaviorHints?.notWebReady !== true) {
    return {
      success: false,
      error: 'proxy stream is missing notWebReady=true',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'video/*,application/vnd.apple.mpegurl,application/x-mpegURL,application/octet-stream;q=0.9,*/*;q=0.2',
        Range: 'bytes=0-65535',
        ...headers,
      },
    });

    if (![200, 206].includes(response.status)) {
      return {
        success: false,
        error: `media HTTP ${response.status}`,
      };
    }

    const contentType = String(
      response.headers.get('content-type') || ''
    ).split(';')[0].trim().toLowerCase();

    if (
      contentType === 'text/html' ||
      contentType === 'application/xhtml+xml'
    ) {
      return {
        success: false,
        error: `media returned ${contentType}`,
      };
    }

    const prefix = await readBounded(response);
    const ascii = prefix.toString('ascii', 0, Math.min(prefix.length, 256));

    const hls =
      /\.m3u8(?:$|[?#])/i.test(url.toString()) ||
      /mpegurl/i.test(contentType);

    if (hls) {
      if (!prefix.toString('utf8').trimStart().startsWith('#EXTM3U')) {
        return {
          success: false,
          error: 'HLS response is not an M3U8 manifest',
        };
      }
    } else {
      const videoContentType =
        contentType.startsWith('video/') ||
        contentType === 'application/octet-stream' ||
        contentType === 'binary/octet-stream';
      const hasMp4Signature = ascii.includes('ftyp');

      if (!videoContentType && !hasMp4Signature) {
        return {
          success: false,
          error: `unrecognized media content-type: ${contentType || 'missing'}`,
        };
      }
    }

    return {
      success: true,
      status: response.status,
      contentType,
      host: url.hostname,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.name === 'AbortError'
        ? 'media validation timed out'
        : error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimited(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;

  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      try {
        output[index] = await mapper(values[index], index);
      } catch (error) {
        output[index] = {
          success: false,
          error: error?.message || String(error),
        };
      }
      await sleep(350);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), values.length || 1) },
      () => worker()
    )
  );

  return output;
}

async function fetchJson(url, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function localProvider() {
  const envPath = process.env.ONLYPORN_ENV_PATH;
  if (envPath && fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
  } else {
    require('dotenv').config();
  }

  process.env.TPB4K_ENABLED = 'true';
  process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE = 'true';
  process.env.ONLYPORN_CACHE_DIR =
    process.env.ONLYPORN_CACHE_DIR ||
    path.join(
      process.cwd(),
      `.yesporn-gate-cache-${process.pid}-${Date.now()}`
    );

  const { Tpb4kProvider } = require('../provider/tpb4k.js');
  const provider = new Tpb4kProvider({ env: process.env });

  return {
    async catalog() {
      const response = await provider.handleCatalog({
        type: 'movie',
        id: 'tpb4k.yesporn.recent',
        extra: { skip: 0 },
      });
      return Array.isArray(response?.metas) ? response.metas : [];
    },
    async streams(id) {
      const response = await provider.handleStream({
        type: 'movie',
        id,
      });
      return Array.isArray(response?.streams) ? response.streams : [];
    },
  };
}

function liveProvider() {
  return {
    async catalog() {
      const body = await fetchJson(
        `${target}/catalog/movie/tpb4k.yesporn.recent.json` +
        `?skip=0&yespornAlpha30=${Date.now()}`,
        180_000
      );
      return Array.isArray(body?.metas) ? body.metas : [];
    },
    async streams(id, attempt) {
      const body = await fetchJson(
        `${target}/stream/movie/${encodeURIComponent(id)}.json` +
        `?yespornAlpha30=${Date.now()}-${attempt}`,
        90_000
      );
      return Array.isArray(body?.streams) ? body.streams : [];
    },
  };
}

async function saveFailurePages(failures) {
  if (mode !== 'local' || !failures.length) return [];

  const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');
  const { decodeStablePathId } = require('../provider/tpb4k/native-html');
  const directory = path.join(
    path.dirname(reportPath),
    'failed-yesporn-pages'
  );
  fs.mkdirSync(directory, { recursive: true });

  const saved = [];

  for (let index = 0; index < failures.length; index += 1) {
    const failure = failures[index];
    const decoded = decodeTpb4kId(failure.id);
    const detailPath = decoded
      ? decodeStablePathId('yesporn', decoded.sourceId)
      : '';

    if (!detailPath) continue;

    const url = `https://yesporn.vip${detailPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
          Referer: 'https://yesporn.vip/',
        },
      });

      const body = await response.text();
      const filename = `${String(index + 1).padStart(2, '0')}-${String(
        detailPath.match(/\/video\/(\d+)\//)?.[1] || 'unknown'
      )}.html`;
      const output = path.join(directory, filename);
      fs.writeFileSync(output, body.slice(0, 2_000_000));

      saved.push({
        title: failure.title,
        detailPath,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        file: output,
      });
    } catch (error) {
      saved.push({
        title: failure.title,
        detailPath,
        error: error?.message || String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return saved;
}

async function main() {
  const provider = mode === 'live'
    ? liveProvider()
    : await localProvider();

  const metas = await provider.catalog();

  const checks = await mapLimited(metas, 2, async meta => {
    let finalStreams = [];
    let finalValidations = [];
    let finalError = 'zero streams';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      finalStreams = await provider.streams(meta.id, attempt);
      finalValidations = [];

      for (const stream of finalStreams) {
        finalValidations.push(await validateMediaStream(stream));
      }

      const playable = finalValidations.some(result => result.success);

      if (playable) {
        finalError = '';
        break;
      }

      finalError = finalStreams.length
        ? finalValidations
          .map(result => result.error)
          .filter(Boolean)
          .join(' | ')
        : 'zero streams';

      if (attempt < 3) await sleep(1_000);
    }

    return {
      title: meta.name,
      id: meta.id,
      poster: meta.poster,
      streams: finalStreams.length,
      validations: finalValidations,
      success: !finalError,
      error: finalError,
    };
  });

  const failures = checks.filter(check => !check.success);
  const failurePages = await saveFailurePages(failures);
  const report = {
    mode,
    target: mode === 'live' ? target : 'local patched provider',
    expectedMinimumCards,
    maximumFailures,
    cards: metas.length,
    testedPosters: checks.length,
    playablePosters: checks.length - failures.length,
    failures,
    failurePages,
    acceptedWithFailures:
      failures.length > 0 &&
      failures.length <= maximumFailures,
    success:
      metas.length >= expectedMinimumCards &&
      checks.length === metas.length &&
      failures.length <= maximumFailures,
    finishedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    reportPath,
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report, null, 2));

  if (!report.success) process.exitCode = 1;
}

main().catch(error => {
  const report = {
    mode,
    success: false,
    error: error?.message || String(error),
    stack:
      process.env.DEBUG_YESPORN_GATE === 'true'
        ? error?.stack
        : undefined,
  };

  fs.writeFileSync(
    reportPath,
    JSON.stringify(report, null, 2) + '\n'
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
});
