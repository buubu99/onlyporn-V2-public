#!/usr/bin/env node
'use strict';

const { catalogDefinitions, isTpb4kEnabled } = require('../catalog/tpb4k');
const { publicConfigStatus, readTpb4kConfig } = require('../provider/tpb4k/config');
const { installBuiltInAdapters, listAdapters } = require('../provider/tpb4k/index');

const config = readTpb4kConfig();
const adapterStatus = installBuiltInAdapters({ config });
const summary = {
  version: require('../package.json').version,
  enabled: isTpb4kEnabled(),
  catalogs: catalogDefinitions.length,
  adapters: listAdapters(),
  configuredMetadataProviders: adapterStatus.configuredProviders,
  config: publicConfigStatus(config),
  selectedCatalogIds: catalogDefinitions.map(item => item.id),
};

console.log(JSON.stringify(summary, null, 2));
