'use strict';

const { buildSceneIdentity } = require('./identity');

const STUDIO_ALIASES = Object.freeze({
  BrazzersExxtra: Object.freeze(['Brazzers Exxtra', 'BrazzersExxtra', 'Brazzers Extra']),
  Cum4K: Object.freeze(['Cum 4K', 'Cum4K']),
  DevilsFilm: Object.freeze(["Devil's Film", 'Devils Film', 'DevilsFilm']),
  DigitalPlayground: Object.freeze(['Digital Playground', 'DigitalPlayground']),
  DorcelClub: Object.freeze(['Dorcel Club', 'DorcelClub', 'Marc Dorcel']),
  MetArt: Object.freeze(['MetArt', 'Met Art']),
  MetArtX: Object.freeze(['MetArt X', 'MetArtX', 'Met Art X']),
  Milfty: Object.freeze(['Milfty', 'MILFTY', 'Milf TY']),
  Milfy: Object.freeze(['Milfy', 'MILFY']),
  NewSensations: Object.freeze(['New Sensations', 'NewSensations']),
  PornMegaLoad: Object.freeze(['Porn Mega Load', 'PornMegaLoad']),
  OnlyFans: Object.freeze(['OnlyFans', 'Only Fans']),
  PlayboyPlus: Object.freeze(['Playboy Plus', 'PlayboyPlus']),
  SexMex: Object.freeze(['SexMex', 'Sex Mex']),
  TheLifeErotic: Object.freeze(['The Life Erotic', 'TheLifeErotic']),
  Vixen: Object.freeze(['Vixen']),
  WowGirls: Object.freeze(['Wow Girls', 'WowGirls']),
  SexArt: Object.freeze(['SexArt', 'Sex Art']),
  XVideosRED: Object.freeze(['XVideos RED', 'XVideosRed', 'XVideosRED', 'XVideos Red']),
});

const CANONICAL_STUDIOS = Object.freeze(Object.keys(STUDIO_ALIASES));

function compactKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const STUDIO_BY_KEY = new Map();
for (const canonical of CANONICAL_STUDIOS) {
  STUDIO_BY_KEY.set(compactKey(canonical), canonical);
  for (const alias of STUDIO_ALIASES[canonical]) STUDIO_BY_KEY.set(compactKey(alias), canonical);
}

function normalizeStudioName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return STUDIO_BY_KEY.get(compactKey(text)) || text;
}

function studioAliases(value) {
  const canonical = normalizeStudioName(value);
  const aliases = STUDIO_ALIASES[canonical] || [canonical];
  const output = [];
  const seen = new Set();
  for (const candidate of [...aliases, canonical]) {
    const text = String(candidate || '').replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return Object.freeze(output);
}

function normalizePerformers(value) {
  const list = Array.isArray(value) ? value : [];
  const names = list
    .map(item => {
      if (typeof item === 'string') return item;
      if (item?.performer?.name) return item.performer.name;
      return item?.name || '';
    })
    .map(name => String(name || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const byKey = new Map();
  for (const name of names) {
    const key = compactKey(name);
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

function safeHttpsUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizedImages(images) {
  return (Array.isArray(images) ? images : [])
    .map(image => ({
      url: safeHttpsUrl(
        image?.url ||
          image?.large ||
          image?.medium ||
          image?.small ||
          image
      ),
      width: Number.parseInt(String(image?.width || 0), 10) || 0,
      height: Number.parseInt(String(image?.height || 0), 10) || 0,
    }))
    .filter(image => image.url);
}

function sceneImages(scene = {}) {
  const values = [];
  for (const collection of [
    scene.images,
    scene.posters,
    scene.backgrounds,
    scene.media,
  ]) {
    if (Array.isArray(collection)) values.push(...collection);
  }
  for (const image of [
    scene.poster,
    scene.poster_image,
    scene.background,
    scene.back_image,
    scene.image,
    scene.thumbnail,
  ]) {
    if (!image) continue;
    if (typeof image === 'object' && !Array.isArray(image)) {
      for (const candidate of [image.large, image.medium, image.small, image.url]) {
        if (candidate) values.push({ url: candidate });
      }
    } else {
      values.push(image);
    }
  }
  return values;
}

function choosePoster(images) {
  const normalized = normalizedImages(images);
  const portrait = normalized
    .filter(image => image.height > image.width)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return (portrait || normalized[0] || {}).url || '';
}

function chooseBackground(images) {
  const normalized = normalizedImages(images);
  const landscape = normalized
    .filter(image => image.width >= image.height)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return (landscape || normalized[0] || {}).url || '';
}

function normalizeScene(provider, scene = {}) {
  const providerId = String(provider || '').trim().toLowerCase();
  const upstreamId = String(scene.id || scene._id || '').trim();
  const title = String(scene.title || scene.name || '').replace(/\s+/g, ' ').trim();
  if (!providerId || !upstreamId || !title) return null;

  const studioCandidates = [
    scene.studio?.name,
    scene.studio?.parent?.name,
    scene.site?.name,
    scene.site?.short_name,
    scene.studio,
    scene.site,
  ]
    .map(normalizeStudioName)
    .filter(Boolean);
  const studio =
    studioCandidates.find(name => CANONICAL_STUDIOS.includes(name)) || studioCandidates[0] || '';
  const performers = normalizePerformers(scene.performers || scene.performer || []);
  const releaseDate = String(scene.release_date || scene.date || scene.releaseDate || '').trim();
  const sceneCode = String(scene.code || scene.sku || scene.sceneCode || '').trim();
  const images = sceneImages(scene);
  const detailUrl = (Array.isArray(scene.urls) ? scene.urls : [scene.url])
    .map(value => safeHttpsUrl(value?.url || value))
    .find(Boolean) || '';

  const item = {
    sourceId: `${providerId}:${upstreamId}`,
    title,
    description: String(scene.details || scene.description || '').trim(),
    poster: choosePoster(images),
    background: chooseBackground(images),
    studio,
    performers,
    releaseDate,
    sceneCode,
    duration: Number.parseInt(String(scene.duration || 0), 10) || 0,
    detailUrl,
    metadataProvider: providerId,
    upstreamId,
  };
  item.sceneIdentity = buildSceneIdentity(item).digest;
  return Object.freeze(item);
}

function mergeMetadataPreservingIdentity(sourceItem = {}, enrichment = {}) {
  const originalIdentity = buildSceneIdentity(sourceItem).digest;
  const merged = {
    ...sourceItem,
    description: sourceItem.description || enrichment.description || '',
    poster: safeHttpsUrl(enrichment.poster) || safeHttpsUrl(sourceItem.poster),
    background:
      safeHttpsUrl(enrichment.background) ||
      safeHttpsUrl(sourceItem.background) ||
      safeHttpsUrl(enrichment.poster) ||
      safeHttpsUrl(sourceItem.poster),
    studio: sourceItem.studio || enrichment.studio || '',
    performers:
      Array.isArray(sourceItem.performers) && sourceItem.performers.length
        ? sourceItem.performers
        : normalizePerformers(enrichment.performers),
    releaseDate: sourceItem.releaseDate || enrichment.releaseDate || '',
    sceneCode: sourceItem.sceneCode || enrichment.sceneCode || '',
    sourceId: sourceItem.sourceId,
    title: sourceItem.title,
  };
  merged.sceneIdentity = originalIdentity;
  return Object.freeze(merged);
}

module.exports = {
  CANONICAL_STUDIOS,
  STUDIO_ALIASES,
  chooseBackground,
  choosePoster,
  mergeMetadataPreservingIdentity,
  normalizePerformers,
  normalizeScene,
  normalizeStudioName,
  safeHttpsUrl,
  sceneImages,
  studioAliases,
};
