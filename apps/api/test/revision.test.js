import assert from 'node:assert/strict';
import test from 'node:test';

import { handleHealth } from '../src/health.js';
import { readAppRevision } from '../src/revision.js';

test('reads the Docker-built application revision for health responses', () => {
  assert.equal(readAppRevision({ readFile: () => 'revision-123\n' }), 'revision-123');
});

test('uses unknown when the revision marker is missing or empty', () => {
  assert.equal(readAppRevision({ readFile: () => '' }), 'unknown');
  assert.equal(readAppRevision({ readFile: () => { throw new Error('missing'); } }), 'unknown');
});

test('health returns the revision after a successful database check', async () => {
  const sent = [];
  await handleHealth({
    repository: { health: async () => ({ db: true }) },
    revision: 'revision-123',
    isProduction: true,
    res: {},
    sendJson: (...args) => sent.push(args)
  });

  assert.deepEqual(sent, [[{}, 200, { ok: true, db: true, revision: 'revision-123' }]]);
});

test('health rejects an unknown revision in production', async () => {
  const sent = [];
  await handleHealth({
    repository: { health: async () => ({ db: true }) },
    revision: 'unknown',
    isProduction: true,
    res: {},
    sendJson: (...args) => sent.push(args)
  });

  assert.deepEqual(sent, [[{}, 503, { ok: false, db: true, revision: 'unknown' }]]);
});

test('health retains revision when its database check fails', async () => {
  const sent = [];
  await handleHealth({
    repository: { health: async () => { throw new Error('database down'); } },
    revision: 'revision-123',
    isProduction: true,
    res: {},
    sendJson: (...args) => sent.push(args),
    logger: { error() {} }
  });

  assert.deepEqual(sent, [[{}, 503, { ok: false, db: false, revision: 'revision-123' }]]);
});
