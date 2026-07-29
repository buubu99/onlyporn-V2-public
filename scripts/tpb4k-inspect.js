#!/usr/bin/env node
'use strict';

const { catalogDefinitions, isTpb4kEnabled } = require('../catalog/tpb4k');
const { publicConfigStatus, readTpb4kConfig } = require('../provider/tpb4k/config');
const { listAdapters } = require('../provider/tpb4k/index');

const config = readTpb4kConfig();
const summary = {
  version: require('../package.json').version,
  enabled: isTpb4kEnabled(),
  catalogs: catalogDefinitions.length,
  adapters: listAdapters(),
  config: publicConfigStatus(config),
  selectedCatalogIds: catalogDefinitions.map(item => item.id),
};

console.log(JSON.stringify(summary, null, 2));
