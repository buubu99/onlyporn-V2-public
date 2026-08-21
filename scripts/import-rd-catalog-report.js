#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRdCatalogSqliteStore } = require('../provider/rd-catalog-sqlite');

function fail(message) {
  process.stderr.write(`RD catalog import failed: ${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const reportPath = path.resolve(String(process.argv[2] || ''));
  if (!process.argv[2] || !fs.statSync(reportPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('usage: node scripts/import-rd-catalog-report.js <final-audit.json>');
  }
  const store = createRdCatalogSqliteStore();
  try {
    const result = await store.importReport(reportPath);
    if (Number(result?.codes || 0) < 1 || Number(result?.complete || 0) < 1) {
      throw new Error('import produced no usable mappings');
    }
    process.stdout.write(`${JSON.stringify({ event: 'RD_CATALOG_IMPORT_COMPLETE', ...result })}\n`);
  } finally {
    await store.close();
  }
}

main().catch(error => fail(error?.message || error));
