#!/usr/bin/env node

const serveHTTP = require('./server-sdk');
const addonInterface = require('./addon');
const logger = require('./logger');
const { startCatalogPrewarmScheduler } = require('./provider/catalog-prewarm');
const { installSukebeiPosterRoute } = require('./provider/tpb4k/sukebei-rss-poster');
const { installStudioReleasePosterRoute } = require('./provider/tpb4k/studio-release-poster');

serveHTTP(addonInterface, {
  port: process.env.PORT || 49581,
  configureApp(app) {
    installSukebeiPosterRoute(app);
    installStudioReleasePosterRoute(app);
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
