import { readFileSync } from 'node:fs';

export function readAppRevision({ path = '/app/REVISION', readFile = readFileSync } = {}) {
  try {
    return readFile(path, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
