import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readAppRevision } from '../src/revision.js';

test('reads the Docker-built application revision for health responses', () => {
  assert.equal(readAppRevision({ readFile: () => 'revision-123\n' }), 'revision-123');
});

test('uses unknown when the revision marker is missing or empty', () => {
  assert.equal(readAppRevision({ readFile: () => '' }), 'unknown');
  assert.equal(readAppRevision({ readFile: () => { throw new Error('missing'); } }), 'unknown');
});

test('health returns the revision and rejects an unknown production marker', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.match(server, /return sendJson\(res, 200, \{ ok: true, \.\.\.health, revision: appRevision \}\)/);
  assert.match(
    server,
    /process\.env\.NODE_ENV === "production" && appRevision === "unknown"[\s\S]*sendJson\(res, 503, \{ ok: false, \.\.\.health, revision: appRevision \}\)/
  );
});
