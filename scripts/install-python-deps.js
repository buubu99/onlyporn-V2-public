#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VENV = path.join(ROOT, '.python-venv');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || `exit status ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${String(detail).trim()}`);
  }

  return result;
}

function findPython() {
  const candidates = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      run(candidate, ['--version'], { quiet: true });
      return candidate;
    } catch {
      // Try the next executable name.
    }
  }
  throw new Error('Python 3 is required to install the SpankBang Safari transport');
}

try {
  if (!fs.existsSync(VENV_PYTHON)) {
    const python = findPython();
    console.log(`Creating OnlyPorn Python environment with ${python}`);
    run(python, ['-m', 'venv', VENV]);
  }

  run(VENV_PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip']);
  run(VENV_PYTHON, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-cache-dir',
    '--upgrade',
    '-r',
    path.join(ROOT, 'requirements.txt'),
  ]);
  console.log('OnlyPorn Python dependencies installed successfully.');
} catch (error) {
  console.error(`Python dependency installation failed: ${error.message}`);
  process.exit(1);
}
