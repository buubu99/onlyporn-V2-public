#!/usr/bin/env node

const fs = require('node:fs');
const serveHTTP = require('./server-sdk');
const addonInterface = require('./addon');
const logger = require('./logger');
const { installJavHdPornPosterProxyRoute } = require('./provider/javhdporn-poster-proxy');
const { startCatalogPrewarmScheduler } = require('./provider/catalog-prewarm');
const { installSukebeiPosterRoute } = require('./provider/tpb4k/sukebei-rss-poster');
const { installStudioReleasePosterRoute } = require('./provider/tpb4k/studio-release-poster');
const { installMetaTubeImageProxyRoute } = require('./provider/tpb4k/metatube-image-proxy');
const { installRuntimeReadinessRoute, snapshot } = require('./provider/runtime-readiness');

logger.info(
  {
    event: 'DEPLOY_CONTAINER_START',
    node: process.version,
    port: Number(process.env.PORT || 49581),
    mediaGeneration: String(process.env.ONLYPORN_MEDIA_GENERATION || ''),
  },
  'DEPLOY_CONTAINER_START'
);

const deploySignalPath = '/tmp/onlyporn-deploy-signal';
process.on('SIGUSR2', () => {
  let action = 'unknown';
  try {
    action = String(fs.readFileSync(deploySignalPath, 'utf8')).trim().toLowerCase();
    fs.unlinkSync(deploySignalPath);
  } catch {
    // The missing marker is itself retained as an unknown deployment event.
  }
  const state = snapshot();
  const event = {
    start: 'DEPLOY_CUTOVER_START',
    live: 'DEPLOY_LIVE',
    rollback: 'DEPLOY_ROLLBACK',
  }[action] || 'DEPLOY_SIGNAL_UNKNOWN';
  const level = action === 'rollback' || action === 'unknown' ? 'warn' : 'info';
  logger[level](
    {
      event,
      action,
      ready: state.ready,
      activeCatalogs: state.catalog.activeCatalogs,
      healthyCatalogs: state.catalog.healthyCatalogs,
      missingCatalogs: state.catalog.missingCatalogs,
    },
    event
  );
});

serveHTTP(addonInterface, {
  port: process.env.PORT || 49581,
  configureApp(app) {
    installJavHdPornPosterProxyRoute(app);
    installSukebeiPosterRoute(app);
    installStudioReleasePosterRoute(app);
    installMetaTubeImageProxyRoute(app);
    installRuntimeReadinessRoute(app);
  },
})
  .then(({ url, server }) => {
    const prewarmRequestTimeoutMs = Number.parseInt(
      String(process.env.ONLYPORN_PREWARM_REQUEST_TIMEOUT_MS || 690_000),
      10
    );
    // Node's five-minute default cut the internal Sukebei prewarm connection
    // before its configured 690-second MetaTube construction budget. Keep the
    // public readiness gate strict, while allowing that one internal request
    // enough time to finish and persist its ephemeral database.
    server.requestTimeout = Math.max(
      Number.isFinite(prewarmRequestTimeoutMs) ? prewarmRequestTimeoutMs + 30_000 : 720_000,
      330_000
    );
    const scheduler = startCatalogPrewarmScheduler({ baseUrl: url });
    server.once('close', () => scheduler.stop());
  })
  .catch(error => {
    logger.fatal(
      { error: error?.message || String(error) },
      'OnlyPorn HTTP server failed to start'
    );
    process.exitCode = 1;
  });
