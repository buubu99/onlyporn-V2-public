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
  'provider/javhdporn-player.js',
  'provider/javhdporn.js',
  'provider/safari-impersonation.js',
  'requirements.txt',
  'scripts/install-python-deps.js',
  'scripts/live-smoke.js',
  'scripts/safari_fetch_helper.py',
  'test/fixtures/hls/master.m3u8',
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
