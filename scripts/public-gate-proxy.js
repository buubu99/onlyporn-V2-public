'use strict';

const http = require('node:http');

const publicPort = Number(process.env.PUBLIC_PORT || process.env.PORT || 10000);
const internalPort = Number(process.env.INTERNAL_ONLYPORN_PORT || 10001);

const server = http.createServer((request, response) => {
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
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
    response.end(`OnlyPorn internal proxy error: ${error.message}`);
  });
  request.pipe(upstream);
});

server.listen(publicPort, '0.0.0.0', () => {
  process.stdout.write(`OnlyPorn public gate opened on port ${publicPort}\n`);
});
