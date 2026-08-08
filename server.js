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
