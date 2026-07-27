const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isBlockedSpankbangHtml,
  isBlockedXhamsterHtml,
} = require('./challenge-detection');

test('ordinary catalog pages are not rejected merely for mentioning captcha or access denied', () => {
  const xhamsterCatalog = `
    <html><head><script>const labels = { captcha: 'Captcha', denied: 'Access denied' };</script></head>
    <body><script>window.initials = {"items":[]};</script>
    <a class="video-thumb" href="/videos/example-video-123">Example</a></body></html>`;
  const spankbangCatalog = `
    <html><head><script>window.messages = { captcha: 'captcha' };</script></head>
    <body><h1>Trending Porn Videos</h1>
    <a class="thumb" href="/abc12/video/example">Example</a></body></html>`;

  assert.equal(isBlockedXhamsterHtml(xhamsterCatalog), false);
  assert.equal(isBlockedSpankbangHtml(spankbangCatalog), false);
});

test('real Cloudflare challenge documents are still rejected', () => {
  const challenge = `
    <html><head><title>Just a moment...</title></head>
    <body><form id="challenge-form" action="/cdn-cgi/challenge-platform/"></form></body></html>`;

  assert.equal(isBlockedXhamsterHtml(challenge), true);
  assert.equal(isBlockedSpankbangHtml(challenge), true);
});

test('xHamster catalog handling uses the proven inherited path instead of Phase 2 aggregation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'xhamster.js'), 'utf8');
  assert.match(source, /async handleCatalog\(args\)/);
  assert.match(source, /return super\.handleCatalog\(args\)/);
  assert.doesNotMatch(source, /await this\.fetchCatalog\(baseUrl, extra\.genre \|\| '', skip\)/);
});

test('SpankBang no longer rejects every page containing the generic word captcha', () => {
  const source = fs.readFileSync(path.join(__dirname, 'spankbang.js'), 'utf8');
  assert.match(source, /isBlockedSpankbangHtml\(html\)/);
  assert.doesNotMatch(source, /Just a moment\|captcha/);
});
