#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const input = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || '');
if (!input || !output || input === output) {
  console.error('Usage: node tools/patch-aiostreams-config-alpha17.js INPUT.json OUTPUT.json');
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(input, 'utf8'));
const preset = (Array.isArray(config.presets) ? config.presets : []).find(item =>
  item?.instanceId === '3a7' || /only\s*2|onlyporn/i.test(String(item?.options?.name || ''))
);
if (!preset) throw new Error('OnlyPorn custom preset was not found');
preset.options ||= {};
preset.options.resources = ['catalog', 'meta', 'stream'];
preset.options.formatPassthrough = true;
preset.options.resultPassthrough = true;

const custom = config.formatter?.definitions?.custom;
if (custom && typeof custom.name === 'string') {
  custom.name = custom.name.replace(
    '{stream.size::sbytes10}',
    '{stream.size::exists[" {stream.size::sbytes10}"||""]}'
  );
}

fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(output, 0o600);
console.log(`Patched AIOStreams configuration written to ${output}`);
console.log('OnlyPorn result/format passthrough enabled; optional stream size is null-safe.');
