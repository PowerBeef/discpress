import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(TESTS, '..');
export const CACHE = path.join(TESTS, '.cache');
export const FIXTURES = process.env.DISCPRESS_FIXTURES || path.join(CACHE, 'fixtures');

export function pageUnderTest() {
  return path.resolve(ROOT, process.env.DISCPRESS_HTML || 'dist/discpress.html');
}

export function pythonBin() {
  const venv = path.join(ROOT, '.venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : 'python3';
}
