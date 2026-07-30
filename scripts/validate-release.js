#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED_VERSION = process.env.EXPECTED_VERSION || packageInfo.version;
const TEXT_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.yml',
  '.yaml',
  '.html',
  '.txt',
]);
const SKIP_DIRECTORIES = new Set(['.git', '.python-venv', '__pycache__', 'node_modules']);
const errors = [];
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}

function relative(file) {
  return path.relative(ROOT, file);
}

walk(ROOT);

if (packageInfo.version !== EXPECTED_VERSION) {
  errors.push(`package.json version ${packageInfo.version} does not match ${EXPECTED_VERSION}`);
}

for (const file of files.filter(file => path.extname(file) === '.js')) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    errors.push(`JavaScript syntax failed: ${relative(file)}\n${String(error.stderr || error.message)}`);
  }
}

const python = process.env.PYTHON_BIN || 'python3';
for (const file of files.filter(file => path.extname(file) === '.py')) {
  try {
    execFileSync(
      python,
      [
        '-c',
        'import ast,pathlib,sys; p=pathlib.Path(sys.argv[1]); ast.parse(p.read_text(encoding="utf-8"), filename=str(p))',
        file,
      ],
      { stdio: 'pipe' }
    );
  } catch (error) {
    errors.push(`Python syntax failed: ${relative(file)}\n${String(error.stderr || error.message)}`);
  }
}

for (const file of files) {
  if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`Trailing whitespace: ${relative(file)}:${index + 1}`);
  });

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    errors.push(`Private key material detected: ${relative(file)}`);
  }
}

for (const forbidden of ['.env', '.env.production', 'id_rsa', 'id_ed25519']) {
  if (files.some(file => path.basename(file) === forbidden)) {
    errors.push(`Forbidden secret-bearing file included: ${forbidden}`);
  }
}

const catalogJsonFiles = fs
  .readdirSync(path.join(ROOT, 'catalog'))
  .filter(name => name.endsWith('.json'));
const catalogIds = catalogJsonFiles.map(name => {
  const value = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', name), 'utf8'));
  if (!value.id || !value.name || value.type !== 'movie') {
    errors.push(`Invalid catalog descriptor: catalog/${name}`);
  }
  return value.id;
});

if (new Set(catalogIds).size !== catalogIds.length) {
  errors.push('Duplicate base catalog IDs were found');
}

const requiredFiles = [
  'provider/phase1.test.js',
  'provider/phase2.test.js',
  'provider/catalog-hotfix.test.js',
  'provider/phase3.test.js',
  'provider/phase4.test.js',
  'provider/phase5.test.js',
  'provider/phase6.test.js',
  'provider/hotfix-2.5.1.test.js',
  'provider/hotfix-2.5.2.test.js',
  'provider/hotfix-2.5.3.test.js',
  'provider/hotfix-2.5.4.test.js',
  'provider/hotfix-2.5.5.test.js',
  'provider/hotfix-2.6.2.test.js',
  'provider/phase0-hardening.test.js',
  'provider/phase1-fail-closed.test.js',
  'provider/tpb4k-phase1.test.js',
  'provider/tpb4k-phase2a.test.js',
  'provider/tpb4k-phase2b.test.js',
  'provider/tpb4k.js',
  'provider/tpb4k/candidate.js',
  'provider/tpb4k/config.js',
  'provider/tpb4k/id-codec.js',
  'provider/tpb4k/identity.js',
  'provider/tpb4k/index.js',
  'provider/tpb4k/source-contract.js',
  'provider/tpb4k/cache.js',
  'provider/tpb4k/graphql-client.js',
  'provider/tpb4k/tpdb-rest-client.js',
  'provider/tpb4k/tpdb-client.js',
  'provider/tpb4k/metadata-normalize.js',
  'provider/tpb4k/poster-enrichment.js',
  'provider/tpb4k-poster-enrichment.test.js',
  'provider/tpb4k-manifest-size.test.js',
  'provider/tpb4k/stashbox-client.js',
  'provider/tpb4k/adapters/metadata.js',
  'provider/tpb4k/adapters/discovery.js',
  'provider/tpb4k/discovery-normalize.js',
  'provider/tpb4k/source-http.js',
  'catalog/tpb4k.js',
  'provider/javhdporn-jw-config.js',
  'provider/javhdporn-safari-impersonation.js',
  'provider/javhdporn-player.js',
  'provider/javhdporn.js',
  'provider/pornhub-safari-impersonation.js',
  'provider/pornhub.js',
  'provider/safari-impersonation.js',
  'requirements.txt',
  'scripts/install-python-deps.js',
  'PHASE0_HARDENING.md',
  'HARDENING_PHASE1.md',
  'DEPLOY_2.6.3.md',
  'DEPLOY_2.6.4.md',
  'TPB4K_PHASE1.md',
  'TPB4K_PHASE2A.md',
  'TPB4K_PHASE2B.md',
  'TPB4K_LICENSE_BOUNDARY.md',
  'TPB4K_POSTER_ENRICHMENT.md',
  'DEPLOY_TPB4K_POSTER_ENRICHMENT.md',
  'DEPLOY_TPB4K_PHASE1.md',
  'DEPLOY_TPB4K_PHASE2A.md',
  'DEPLOY_TPB4K_PHASE2B.md',
  'scripts/tpb4k-inspect.js',
  'scripts/tpb4k-metadata-smoke.js',
  'scripts/tpb4k-discovery-smoke.js',
  'scripts/tpb4k-render-smoke.js',
  'scripts/javhdporn-vdcdn-smoke.js',
  'scripts/javhdporn_jw_capture.js',
  'scripts/javhdporn_safari_fetch_helper.py',
  'scripts/live-smoke.js',
  'scripts/pornhub_safari_fetch_helper.py',
  'scripts/safari_fetch_helper.py',
  'test/fixtures/hls/master.m3u8',
  'test/fixtures/pornhub/catalog.html',
  'test/fixtures/pornhub/video.html',
  'test/fixtures/pornhub/mp4-response.json',
  'assets/tpb4k/studios/brazzersexxtra.png',
  'assets/tpb4k/studios/cum4k.png',
  'assets/tpb4k/studios/devilsfilm.png',
  'assets/tpb4k/studios/digitalplayground.png',
  'assets/tpb4k/studios/dorcelclub.png',
  'assets/tpb4k/studios/metart.png',
  'assets/tpb4k/studios/metartx.png',
  'assets/tpb4k/studios/milfty.png',
  'assets/tpb4k/studios/milfy.png',
  'assets/tpb4k/studios/newsensations.png',
  'assets/tpb4k/studios/pornmegaload.png',
  'assets/tpb4k/studios/onlyfans.png',
  'assets/tpb4k/studios/playboyplus.png',
  'assets/tpb4k/studios/sexmex.png',
  'assets/tpb4k/studios/thelifeerotic.png',
  'assets/tpb4k/studios/vixen.png',
  'assets/tpb4k/studios/wowgirls.png',
  'assets/tpb4k/studios/sexart.png',
  'assets/tpb4k/studios/xvideosred.png',
  'assets/tpb4k/studios/tpdb.png',
  'assets/tpb4k/studios/pornrips.png',
  'assets/tpb4k/studios/yesporn.png',
  'assets/tpb4k/studios/hentai.png',
  'assets/tpb4k/studios/sukebei.png',
  'assets/tpb4k/studios/stripchat.png',
  'assets/tpb4k/studios/tpb4k.png',
];
for (const required of requiredFiles) {
  if (!fs.existsSync(path.join(ROOT, required))) errors.push(`Required release file missing: ${required}`);
}

if (errors.length) {
  console.error(`Release validation failed with ${errors.length} problem(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const jsCount = files.filter(file => path.extname(file) === '.js').length;
const pyCount = files.filter(file => path.extname(file) === '.py').length;
console.log(`Release validation passed for OnlyPorn ${packageInfo.version}.`);
console.log(`${jsCount} JavaScript files and ${pyCount} Python files passed syntax checks.`);
console.log(`${files.length} repository files inspected; no forbidden secret files or trailing whitespace found.`);
