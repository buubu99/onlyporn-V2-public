#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const baseUrl = String(
  process.argv[2] ||
  process.env.ONLYPORN_TEST_URL ||
  'http://127.0.0.1:49631'
).replace(/\/+$/, '');

const expectedCards = Math.max(
  Number.parseInt(process.env.EXPECTED_CARDS || '40', 10) || 40,
  1
);

const minimumPlayable = Math.max(
  Math.min(
    Number.parseInt(process.env.MINIMUM_PLAYABLE || '30', 10) || 30,
    expectedCards
  ),
  1
);

const reportPath =
  process.env.YESPORN_REPORT ||
  path.join(process.cwd(), 'yesporn-relay-report.json');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

    const text = await response.text();
    let body = {};

    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON HTTP ${response.status}: ${text.slice(0, 180)}`
      );
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function readPrefix(response, maximum = 65_536) {
  const reader = response.body?.getReader?.();

  if (!reader) {
    return Buffer.from(
      await response.arrayBuffer()
    ).subarray(0, maximum);
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

async function validateRelayStream(stream) {
  const rawUrl = String(stream?.url || '');
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return {
      success: false,
      error: 'invalid stream URL',
    };
  }

  const expected = new URL(baseUrl);

  if (url.origin !== expected.origin) {
    return {
      success: false,
      error: `stream escaped relay origin: ${url.origin}`,
    };
  }

  if (!/^\/media\/[^/]+\/video\.mp4$/.test(url.pathname)) {
    return {
      success: false,
      error: `stream is not a YesPorn MP4 relay URL: ${url.pathname}`,
    };
  }

  if (stream.behaviorHints?.proxyHeaders) {
    return {
      success: false,
      error: 'relay stream unexpectedly exposes proxyHeaders',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.2',
        Range: 'bytes=0-65535',
      },
    });

    if (![200, 206].includes(response.status)) {
      return {
        success: false,
        error: `relay HTTP ${response.status}`,
      };
    }

    const contentType = String(
      response.headers.get('content-type') || ''
    ).split(';')[0].trim().toLowerCase();

    if (
      contentType === 'text/html' ||
      contentType.startsWith('image/')
    ) {
      return {
        success: false,
        error: `relay returned ${contentType}`,
      };
    }

    const prefix = await readPrefix(response);
    const ascii = prefix.toString(
      'ascii',
      0,
      Math.min(prefix.length, 256)
    );

    const videoType =
      contentType.startsWith('video/') ||
      contentType === 'application/octet-stream' ||
      contentType === 'binary/octet-stream';

    if (!videoType && !ascii.includes('ftyp')) {
      return {
        success: false,
        error:
          `relay payload is not recognized as MP4; ` +
          `content-type=${contentType || 'missing'}`,
      };
    }

    return {
      success: true,
      status: response.status,
      contentType,
      contentRange:
        response.headers.get('content-range') || '',
      contentLength:
        response.headers.get('content-length') || '',
    };
  } catch (error) {
    return {
      success: false,
      error:
        error?.name === 'AbortError'
          ? 'relay validation timed out'
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
        output[index] = await mapper(
          values[index],
          index
        );
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
      {
        length: Math.min(
          Math.max(concurrency, 1),
          values.length || 1
        ),
      },
      () => worker()
    )
  );

  return output;
}

async function testPoster(meta, index) {
  let lastError = 'zero streams';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const body = await fetchJson(
      `${baseUrl}/stream/movie/${encodeURIComponent(meta.id)}.json` +
      `?yespornRelay=${Date.now()}-${index}-${attempt}`,
      120_000
    );

    const streams = Array.isArray(body?.streams)
      ? body.streams
      : [];

    if (!streams.length) {
      lastError = 'zero streams';
      if (attempt < 3) await sleep(1_000);
      continue;
    }

    if (streams.length > 6) {
      return {
        title: meta.name,
        id: meta.id,
        streams: streams.length,
        success: false,
        error:
          `resolver returned ${streams.length} streams; ` +
          'expected at most six authoritative qualities',
      };
    }

    const malformed = streams.find(stream => {
      try {
        const url = new URL(String(stream?.url || ''));
        return (
          url.origin !== new URL(baseUrl).origin ||
          !/^\/media\/[^/]+\/video\.mp4$/.test(url.pathname)
        );
      } catch {
        return true;
      }
    });

    if (malformed) {
      return {
        title: meta.name,
        id: meta.id,
        streams: streams.length,
        success: false,
        error: 'one or more streams bypassed the OnlyPorn media relay',
      };
    }

    const validations = [];

    for (const stream of streams) {
      const validation =
        await validateRelayStream(stream);
      validations.push(validation);

      if (validation.success) break;
    }

    if (validations.some(result => result.success)) {
      return {
        title: meta.name,
        id: meta.id,
        streams: streams.length,
        playableStreams:
          validations.filter(result => result.success).length,
        validations,
        success: true,
      };
    }

    lastError = validations
      .map(result => result.error)
      .filter(Boolean)
      .join(' | ') || 'no relay stream validated';

    if (attempt < 3) await sleep(1_000);
  }

  return {
    title: meta.name,
    id: meta.id,
    streams: 0,
    success: false,
    error: lastError,
  };
}

async function main() {
  const catalog = await fetchJson(
    `${baseUrl}/catalog/movie/tpb4k.yesporn.recent.json` +
    `?skip=0&yespornRelay=${Date.now()}`,
    180_000
  );

  const metas = Array.isArray(catalog?.metas)
    ? catalog.metas
    : [];

  const checks = await mapLimited(
    metas,
    2,
    testPoster
  );

  const failures = checks.filter(
    check => !check.success
  );

  const report = {
    target: baseUrl,
    expectedCards,
    minimumPlayable,
    cards: metas.length,
    testedPosters: checks.length,
    playablePosters:
      checks.length - failures.length,
    failures,
    success:
      metas.length === expectedCards &&
      checks.length === expectedCards &&
      checks.length - failures.length >= minimumPlayable,
    finishedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    reportPath,
    JSON.stringify(report, null, 2) + '\n'
  );

  console.log(
    JSON.stringify(report, null, 2)
  );

  if (!report.success) process.exitCode = 1;
}

main().catch(error => {
  const report = {
    target: baseUrl,
    success: false,
    error: error?.message || String(error),
  };

  fs.writeFileSync(
    reportPath,
    JSON.stringify(report, null, 2) + '\n'
  );

  console.error(
    JSON.stringify(report, null, 2)
  );

  process.exitCode = 1;
});
