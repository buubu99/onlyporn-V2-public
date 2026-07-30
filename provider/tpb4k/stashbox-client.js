'use strict';

const { StashBoxGraphqlClient } = require('./graphql-client');

const SCENE_FIELDS = `
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

const QUERY_SCENES = `
query OnlyPornQueryScenes($input: SceneQueryInput!) {
  queryScenes(input: $input) {
    count
    scenes { ${SCENE_FIELDS} }
  }
}`;

const FIND_SCENE = `
query OnlyPornFindScene($id: ID!) {
  findScene(id: $id) { ${SCENE_FIELDS} }
}`;

function positiveInteger(value, fallback, max = 100) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, 1), max);
}

function sceneInput(options = {}) {
  const input = {
    page: positiveInteger(options.page, 1, 100_000),
    per_page: positiveInteger(options.perPage, 40, 100),
    direction: 'DESC',
    sort: options.sort === 'POPULARITY' ? 'POPULARITY' : 'DATE',
  };
  const studio = String(options.studio || '').replace(/\s+/g, ' ').trim();
  const title = String(options.title || '').replace(/\s+/g, ' ').trim();
  const text = String(options.text || '').replace(/\s+/g, ' ').trim();
  if (studio) input.parentStudio = studio;
  if (title) input.title = title;
  else if (text) input.text = text;
  return input;
}

class StashBoxMetadataClient {
  constructor(options = {}) {
    this.id = String(options.id || 'metadata').trim().toLowerCase();
    this.client = new StashBoxGraphqlClient({ ...options, name: this.id });
  }

  get configured() {
    return this.client.configured;
  }

  async queryScenes(options = {}) {
    if (!this.configured) return [];
    const data = await this.client.request(QUERY_SCENES, {
      input: sceneInput(options),
    });
    return Array.isArray(data?.queryScenes?.scenes) ? data.queryScenes.scenes : [];
  }

  async findScene(id) {
    const upstreamId = String(id || '').trim();
    if (!this.configured || !upstreamId) return null;
    const data = await this.client.request(
      FIND_SCENE,
      { id: upstreamId },
      { negativeOnNull: true }
    );
    return data?.findScene || null;
  }
}

module.exports = {
  FIND_SCENE,
  QUERY_SCENES,
  SCENE_FIELDS,
  StashBoxMetadataClient,
  sceneInput,
};
