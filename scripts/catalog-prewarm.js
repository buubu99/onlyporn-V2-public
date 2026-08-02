#!/usr/bin/env node
'use strict';

const logger = require('../logger');
const { runCatalogPrewarm } = require('../provider/catalog-prewarm');

const baseUrl = String(
  process.env.ONLYPORN_PREWARM_BASE_URL ||
  process.env.DIAGNOSTIC_BASE_URL ||
  'https://onlyporn-v2-public-k143.onrender.com'
).replace(/\/+$/, '');

runCatalogPrewarm({
  baseUrl,
  concurrency: process.env.ONLYPORN_PREWARM_CONCURRENCY,
  maxPasses: process.env.ONLYPORN_PREWARM_MAX_PASSES,
  retryDelayMs: process.env.ONLYPORN_PREWARM_RETRY_DELAY_MS,
  requestTimeoutMs: process.env.ONLYPORN_PREWARM_REQUEST_TIMEOUT_MS,
  expectedActiveCatalogs: process.env.ONLYPORN_PREWARM_EXPECTED_ACTIVE,
  verificationPasses: process.env.ONLYPORN_PREWARM_VERIFICATION_PASSES,
})
  .then(result => {
    if (!result.success) process.exitCode = 1;
  })
  .catch(error => {
    logger.error(
      { error: error?.message || String(error) },
      'OnlyPorn manual catalog prewarm failed'
    );
    process.exitCode = 1;
  });
