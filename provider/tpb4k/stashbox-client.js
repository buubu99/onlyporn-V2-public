'use strict';

const { StashBoxGraphqlClient } = require('./graphql-client');

const BASE_SCENE_FIELDS = `
  id
  title
  details
  release_date
  code
  duration
  urls { url }
  studio { id name parent { id name } }
  images { id url width height }
  performers { as performer { id name disambiguation aliases images { id url width height } } }
`;

const EXTENDED_SCENE_FIELDS = `
  id
  title
  details
  release_date
  code
  duration
  urls { url }
  studio { id name parent { id name } }
  images { id url width height }
  tags { id name }
  performers { as performer { id name gender disambiguation aliases images { id url width height } } }
`;

const STUDIO_FIELDS = `
  id
  name
  aliases
  parent { id name }
`;

const SCENE_FIELDS = EXTENDED_SCENE_FIELDS;

function queryDocument(fields) {
  return `
query OnlyPornQueryScenes($input: SceneQueryInput!) {
  queryScenes(input: $input) {
    count
    scenes { ${fields} }
  }
}`;
}

function findDocument(fields) {
  return `
query OnlyPornFindScene($id: ID!) {
  findScene(id: $id) { ${fields} }
}`;
}

const QUERY_SCENES = queryDocument(EXTENDED_SCENE_FIELDS);
const QUERY_SCENES_BASE = queryDocument(BASE_SCENE_FIELDS);
const FIND_SCENE = findDocument(EXTENDED_SCENE_FIELDS);
const FIND_SCENE_BASE = findDocument(BASE_SCENE_FIELDS);
const FIND_STUDIO = `
query OnlyPornFindStudio($name: String!) {
  findStudio(name: $name) { ${STUDIO_FIELDS} }
}`;
const QUERY_STUDIOS = `
query OnlyPornQueryStudios($input: StudioQueryInput!) {
  queryStudios(input: $input) {
    count
    studios { ${STUDIO_FIELDS} }
  }
}`;

function positiveInteger(value, fallback, max = 100) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, 1), max);
}

function compactKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function uniqueStrings(values) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const key = compactKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function sceneInput(options = {}) {
  const input = {
    page: positiveInteger(options.page, 1, 100_000),
    per_page: positiveInteger(options.perPage, 40, 100),
    direction: 'DESC',
    sort: options.sort === 'POPULARITY' ? 'POPULARITY' : 'DATE',
  };

  const studioIds = uniqueStrings(options.studioIds || options.studios || []);
  if (studioIds.length) {
    input.studios = { value: studioIds, modifier: 'INCLUDES' };
  }

  const title = String(options.title || options.text || options.query || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) input.title = title;

  if (options.parentStudio) {
    input.parentStudio = String(options.parentStudio).replace(/\s+/g, ' ').trim();
  }
  return input;
}

function studioQueryInput(name, options = {}) {
  return {
    names: String(name || '').replace(/\s+/g, ' ').trim(),
    page: positiveInteger(options.page, 1, 100_000),
    per_page: positiveInteger(options.perPage, 25, 100),
    direction: 'ASC',
    sort: 'NAME',
  };
}

function studioNames(studio = {}) {
  return uniqueStrings([studio.name, ...(Array.isArray(studio.aliases) ? studio.aliases : [])]);
}

function exactStudioMatch(studio, acceptedKeys) {
  return studioNames(studio).some(name => acceptedKeys.has(compactKey(name)));
}

function schemaCompatibilityError(error) {
  return /cannot query field|unknown field|graphql validation|not defined by type/i.test(
    String(error?.message || '')
  );
}

class StashBoxMetadataClient {
  constructor(options = {}) {
    this.id = String(options.id || 'metadata').trim().toLowerCase();
    this.client = new StashBoxGraphqlClient({ ...options, name: this.id });
    this.extendedFieldsSupported = true;
  }

  get configured() {
    return this.client.configured;
  }

  async resolveStudioIds(names = []) {
    if (!this.configured) return [];
    const aliases = uniqueStrings(names).slice(0, 6);
    if (!aliases.length) return [];
    const acceptedKeys = new Set(aliases.map(compactKey));
    const byId = new Map();

    // Exact lookup is inexpensive and deterministic. It also benefits from the
    // GraphQL client's bounded positive/negative cache.
    for (const name of aliases) {
      let data;
      try {
        data = await this.client.request(FIND_STUDIO, { name }, { negativeOnNull: true });
      } catch (error) {
        if (!schemaCompatibilityError(error)) throw error;
      }
      const studio = data?.findStudio;
      if (studio?.id && exactStudioMatch(studio, acceptedKeys)) {
        byId.set(String(studio.id), studio);
      }
    }

    // Some databases store a requested brand as an alias. Resolve those via a
    // bounded name/alias search, but accept only exact normalized names.
    if (!byId.size) {
      for (const name of aliases) {
        const data = await this.client.request(QUERY_STUDIOS, {
          input: studioQueryInput(name),
        });
        const studios = Array.isArray(data?.queryStudios?.studios)
          ? data.queryStudios.studios
          : [];
        for (const studio of studios) {
          if (studio?.id && exactStudioMatch(studio, acceptedKeys)) {
            byId.set(String(studio.id), studio);
          }
        }
        if (byId.size) break;
      }
    }

    return [...byId.keys()];
  }

  async queryScenes(options = {}) {
    if (!this.configured) return [];
    const variables = { input: sceneInput(options) };
    let data;
    if (this.extendedFieldsSupported) {
      try {
        data = await this.client.request(QUERY_SCENES, variables);
      } catch (error) {
        if (!schemaCompatibilityError(error)) throw error;
        this.extendedFieldsSupported = false;
      }
    }
    if (!data) data = await this.client.request(QUERY_SCENES_BASE, variables);
    return Array.isArray(data?.queryScenes?.scenes) ? data.queryScenes.scenes : [];
  }

  async findScene(id) {
    const upstreamId = String(id || '').trim();
    if (!this.configured || !upstreamId) return null;
    const variables = { id: upstreamId };
    let data;
    if (this.extendedFieldsSupported) {
      try {
        data = await this.client.request(FIND_SCENE, variables, { negativeOnNull: true });
      } catch (error) {
        if (!schemaCompatibilityError(error)) throw error;
        this.extendedFieldsSupported = false;
      }
    }
    if (!data) {
      data = await this.client.request(FIND_SCENE_BASE, variables, { negativeOnNull: true });
    }
    return data?.findScene || null;
  }
}

module.exports = {
  BASE_SCENE_FIELDS,
  EXTENDED_SCENE_FIELDS,
  FIND_SCENE,
  FIND_SCENE_BASE,
  FIND_STUDIO,
  QUERY_SCENES,
  QUERY_SCENES_BASE,
  QUERY_STUDIOS,
  SCENE_FIELDS,
  STUDIO_FIELDS,
  StashBoxMetadataClient,
  compactKey,
  exactStudioMatch,
  sceneInput,
  schemaCompatibilityError,
  studioNames,
  studioQueryInput,
  uniqueStrings,
};
