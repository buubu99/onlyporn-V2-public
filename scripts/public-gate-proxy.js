'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const publicPort = Number(process.env.PUBLIC_PORT || process.env.PORT || 10000);
const internalPort = Number(process.env.INTERNAL_ONLYPORN_PORT || 10001);
const runtimeDir = path.resolve(String(
  process.env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime'
));
const readyMarkerPath = path.join(runtimeDir, 'startup-prewarm-ready.json');

let readyAnnounced = false;

function sendJson(response, statusCode, payload, headOnly = false) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  response.end(headOnly ? undefined : body);
}

function readValidMarker() {
  try {
    const marker = JSON.parse(fs.readFileSync(readyMarkerPath, 'utf8'));
    const metas = Number(marker?.sukebei?.metas || 0);
    const posters = Number(marker?.sukebei?.metatubePosters || 0);

    if (
      marker?.ready === true &&
      marker?.gate === 'catalog-prewarm-success' &&
      Number(marker?.activeCatalogs) === 34 &&
      Number(marker?.healthyCatalogs) === 34 &&
      Array.isArray(marker?.missingCatalogs) &&
      marker.missingCatalogs.length === 0 &&
      marker?.sukebei?.healthy === true &&
      marker?.sukebei?.strictMetaTube === true &&
      metas >= 24 &&
      metas <= 40 &&
      posters === metas &&
      Number(marker?.sukebei?.generatedPosters || 0) === 0
      && marker?.sukebeiHentai?.healthy === true
      && marker?.sukebeiHentai?.sqliteComplete === true
      && Number(marker?.sukebeiHentai?.dbBytes || 0) > 0
      && Number(marker?.sukebeiHentai?.metas || 0) >= 18
      && Number(marker?.sukebeiHentai?.metas || 0) <= 40
    ) {
      return marker;
    }
  } catch {}

  return null;
}

function handleReady(request, response) {
  const marker = readValidMarker();

  if (!marker) {
    sendJson(response, 503, {
      ready: false,
      gate: 'catalog-prewarm-success',
      waitingFor: '34/34 prewarm + strict Sukebei MetaTube + complete Sukebei Hentai SQLite index',
    }, request.method === 'HEAD');
    return;
  }

  if (!readyAnnounced) {
    readyAnnounced = true;
    process.stdout.write(
      `OnlyPorn PUBLIC READY: /onlyporn/ready=200; marker=${readyMarkerPath}\n`
    );
  }

  sendJson(response, 200, marker, request.method === 'HEAD');
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
    handleReady(request, response);
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
    response.writeHead(
      upstreamResponse.statusCode || 502,
      upstreamResponse.headers
    );
    upstreamResponse.pipe(response);
  });

  upstream.on('error', error => {
    if (!response.headersSent) {
      response.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
      });
    }
    response.end(`OnlyPorn internal proxy error: ${error.message}`);
  });

  request.pipe(upstream);
});

server.listen(publicPort, '0.0.0.0', () => {
  process.stdout.write(
    `OnlyPorn public gate opened on port ${publicPort}; ` +
    `waiting on ${readyMarkerPath}\n`
  );
});
