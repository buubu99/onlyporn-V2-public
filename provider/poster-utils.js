function stableFrame(seed, max = 30) {
  let hash = 2166136261;
  for (const char of String(seed || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % max + 1;
}

function resolveTemplateFrame(url, seed, max = 30) {
  if (!url) return url;
  return String(url).replace(/THUMBNUM/g, String(stableFrame(seed, max)));
}

module.exports = {
  resolveTemplateFrame,
  stableFrame,
};
