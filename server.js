#!/usr/bin/env node

const serveHTTP = require('./server-sdk');
const addonInterface = require('./addon');
const logger = require('./logger');
const { installJavHdPornPosterProxyRoute } = require('./provider/javhdporn-poster-proxy');
const { startCatalogPrewarmScheduler } = require('./provider/catalog-prewarm');
const { installSukebeiPosterRoute } = require('./provider/tpb4k/sukebei-rss-poster');
const { installStudioReleasePosterRoute } = require('./provider/tpb4k/studio-release-poster');
const { installMetaTubeImageProxyRoute } = require('./provider/tpb4k/metatube-image-proxy');
const { installRuntimeReadinessRoute } = require('./provider/runtime-readiness');

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
