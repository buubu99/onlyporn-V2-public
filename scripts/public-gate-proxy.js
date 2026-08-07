'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const publicPort = Number(process.env.PUBLIC_PORT || process.env.PORT || 10000);
const internalPort = Number(process.env.INTERNAL_ONLYPORN_PORT || 10001);
const runtimeDir = path.resolve(String(
  process.env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime'
));
const readyMarkerPath = path.join(runtimeDir, 'startup-ready.json');

let readyAnnounced = false;

function writeJson(response, statusCode, payload, headOnly = false) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  response.end(headOnly ? undefined : body);
}

function readReadyMarker() {
  try {
    const parsed = JSON.parse(fs.readFileSync(readyMarkerPath, 'utf8'));
    if (
      parsed?.ready === true &&
      parsed?.catalog?.success === true &&
      Number(parsed?.catalog?.activeCatalogs) === 33 &&
      Number(parsed?.catalog?.healthyCatalogs) === 33 &&
      parsed?.sukebei?.ready === true
    ) {
      const cards = Number(parsed.sukebei.cards || 0);
      const posters = Number(parsed.sukebei.metatubePosters || 0);
      const generated = Number(parsed.sukebei.generatedPosters || 0);
      if (cards >= 24 && cards <= 40 && posters === cards && generated === 0) {
        return parsed;
      }
    }
  } catch {}
  return null;
}

function handleReadiness(request, response) {
  const marker = readReadyMarker();
  if (!marker) {
    writeJson(response, 503, {
      ready: false,
      gate: 'startup-ready-marker',
      waitingFor: 'strict Sukebei 24-40 MetaTube cards + 33/33 startup prewarm',
    }, request.method === 'HEAD');
    return;
  }

  if (!readyAnnounced) {
    readyAnnounced = true;
    process.stdout.write(
      `OnlyPorn public readiness OPEN: /onlyporn/ready -> 200; marker=${readyMarkerPath}\n`
    );
  }

  writeJson(response, 200, marker, request.method === 'HEAD');
}

const server = http.createServer((request, response) => {
  let pathname = '';
  try {
    pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  } catch {}

  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    pathname === '/onlyporn/ready'
  ) {
    handleReadiness(request, response);
    return;
  }

  const upstream = http.request({
    host: '127.0.0.1',
    port: internalPort,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      host: `127.0.0.1:${internalPort}`,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': request.headers.host || '',
    },
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', error => {
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end(`OnlyPorn internal proxy error: ${error.message}`);
  });

  request.pipe(upstream);
});

server.listen(publicPort, '0.0.0.0', () => {
  process.stdout.write(
    `OnlyPorn public gate opened on port ${publicPort}; readiness marker=${readyMarkerPath}\n`
  );
});
