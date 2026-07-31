'use strict';

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

const ALIASES = Object.freeze({
  brazzersexxtra: Object.freeze(['BrazzersExxtra', 'Brazzers Exxtra', 'Brazzers Extra']),
  cum4k: Object.freeze(['Cum4K', 'Cum 4K']),
  devilsfilm: Object.freeze(['DevilsFilm', 'Devils Film']),
  digitalplayground: Object.freeze(['DigitalPlayground', 'Digital Playground', 'Digital Playground 4K']),
  dorcelclub: Object.freeze(['DorcelClub', 'Dorcel Club', 'Marc Dorcel']),
  metart: Object.freeze(['MetArt', 'Met Art']),
  metartx: Object.freeze(['MetArtX', 'Met Art X', 'MetArt X']),
  milfty: Object.freeze(['Milfty', 'MilfTY']),
  milfy: Object.freeze(['Milfy']),
  newsensations: Object.freeze(['NewSensations', 'New Sensations']),
  onlyfans: Object.freeze(['OnlyFans', 'Only Fans']),
  playboyplus: Object.freeze(['PlayboyPlus', 'Playboy Plus']),
  pornmegaload: Object.freeze(['PornMegaLoad', 'Porn Mega Load']),
  sexart: Object.freeze(['SexArt', 'Sex Art']),
  sexmex: Object.freeze(['SexMex', 'Sex Mex']),
  thelifeerotic: Object.freeze(['TheLifeErotic', 'The Life Erotic', 'LifeErotic']),
  vixen: Object.freeze(['Vixen']),
  wowgirls: Object.freeze(['WowGirls', 'Wow Girls']),
  xvideosred: Object.freeze(['XVideosRED', 'XVideos RED', 'XVideosRed', 'XVideos.com RED']),
});

function aliasKey(value) {
  return compact(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function studioAliases(value) {
  const original = compact(value);
  const configured = ALIASES[aliasKey(original)] || Object.freeze([original]);
  return Object.freeze([...new Set([original, ...configured].map(compact).filter(Boolean))]);
}

function studioSearchQueries(catalog = {}) {
  const aliases = studioAliases(catalog.studio);
  // Extra aliases are used only for the catalogue-time identity pool. Ordinary
  // click-time resolution retains the exact title query path.
  return catalog.playbackBindingPool ? aliases : Object.freeze(aliases.slice(0, 1));
}

function normalizedAliasKeys(value) {
  return Object.freeze(studioAliases(value).map(aliasKey).filter(key => key.length >= 4));
}

module.exports = { ALIASES, aliasKey, normalizedAliasKeys, studioAliases, studioSearchQueries };
