function hasStrongChallengeMarker(html) {
  const source = String(html || '');
  if (!source) return false;

  return (
    /<title[^>]*>\s*(?:just a moment|access denied|attention required|security check|verify you are human)[^<]*<\/title>/i.test(source) ||
    /id=["'](?:challenge-form|cf-chl-widget|turnstile-wrapper)["']/i.test(source) ||
    /class=["'][^"']*(?:cf-chl|challenge-form|challenge-running)[^"']*["']/i.test(source) ||
    /\/cdn-cgi\/challenge-platform\//i.test(source) ||
    /cf-chl-(?:managed|captcha|jschl|widget)/i.test(source)
  );
}

function hasXhamsterCatalogEvidence(html) {
  const source = String(html || '');
  return (
    /window\.initials\s*=/i.test(source) ||
    /class=["'][^"']*(?:thumb-list__item|video-thumb)[^"']*["']/i.test(source) ||
    /href=["'][^"']*\/videos\//i.test(source)
  );
}

function hasSpankbangCatalogEvidence(html) {
  const source = String(html || '');
  return (
    /href=["'][^"']*\/[a-z0-9]+\/video\//i.test(source) ||
    /class=["'][^"']*(?:thumb|video-item)[^"']*["']/i.test(source) ||
    /trending\s+porn\s+videos/i.test(source)
  );
}

function isBlockedXhamsterHtml(html) {
  const source = String(html || '');
  if (!source.trim()) return true;
  return hasStrongChallengeMarker(source) && !hasXhamsterCatalogEvidence(source);
}

function isBlockedSpankbangHtml(html) {
  const source = String(html || '');
  if (!source.trim()) return true;
  return hasStrongChallengeMarker(source) && !hasSpankbangCatalogEvidence(source);
}

module.exports = {
  hasStrongChallengeMarker,
  hasSpankbangCatalogEvidence,
  hasXhamsterCatalogEvidence,
  isBlockedSpankbangHtml,
  isBlockedXhamsterHtml,
};
