#!/usr/bin/env node

const serveHTTP = require('./server-sdk');
const addonInterface = require('./addon');
const { installSukebeiPosterRoute } = require('./provider/tpb4k/sukebei-rss-poster');
serveHTTP(addonInterface, { port: process.env.PORT || 49581, configureApp: installSukebeiPosterRoute });
