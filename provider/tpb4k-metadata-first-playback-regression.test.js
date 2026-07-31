'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDefinitions } = require('../catalog/tpb4k');

const studioRows = catalogDefinitions.filter(definition =>
  String(definition.id || '').startsWith('tpb4k.studio.')
);

test('regression 0e16aac: studio cards remain metadata-first with torrent lookup provenance', () => {
  assert.equal(studioRows.length, 19);

  const onlyFans = studioRows.find(definition => definition.studio === 'OnlyFans');
  const conventionalStudios = studioRows.filter(definition => definition.studio !== 'OnlyFans');

  assert.ok(onlyFans, 'OnlyFans studio row must exist');
  assert.equal(onlyFans.source, 'platform-hybrid');
  assert.equal(onlyFans.lookupSource, 'torrent-index');

  assert.equal(conventionalStudios.length, 18);
  assert.ok(conventionalStudios.every(definition => definition.source === 'studio-metadata'));
  assert.ok(studioRows.every(definition => definition.lookupSource === 'torrent-index'));
  assert.ok(studioRows.every(definition => definition.source !== 'torrent-index'));
});
