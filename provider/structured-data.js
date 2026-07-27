function flattenStructuredData(value, output = []) {
  if (!value || typeof value !== 'object') return output;

  if (Array.isArray(value)) {
    for (const item of value) flattenStructuredData(item, output);
    return output;
  }

  output.push(value);
  if (Array.isArray(value['@graph'])) {
    for (const item of value['@graph']) flattenStructuredData(item, output);
  }

  return output;
}

function parseStructuredDataBlocks(blocks) {
  const output = [];

  for (const block of blocks || []) {
    if (typeof block !== 'string' || !block.trim()) continue;
    try {
      flattenStructuredData(JSON.parse(block), output);
    } catch {
      // Ignore malformed JSON-LD blocks and continue to the next one.
    }
  }

  return output;
}

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find(item => typeof item === 'string') || null;
  return null;
}

function findVideoObject(objects) {
  return (objects || []).find(object => {
    const type = object?.['@type'];
    if (Array.isArray(type)) return type.some(value => String(value).toLowerCase() === 'videoobject');
    return String(type || '').toLowerCase() === 'videoobject';
  }) || (objects || [])[0] || null;
}

function collectStructuredMediaUrls(objects) {
  const candidates = [];

  for (const object of objects || []) {
    for (const key of ['contentUrl', 'embedUrl']) {
      const value = object?.[key];
      if (typeof value === 'string') {
        candidates.push({ url: value, context: `json-ld ${key}` });
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            candidates.push({ url: item, context: `json-ld ${key}` });
          }
        }
      }
    }
  }

  return candidates;
}

module.exports = {
  collectStructuredMediaUrls,
  findVideoObject,
  firstString,
  flattenStructuredData,
  parseStructuredDataBlocks,
};
