import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScenario } from '../public/workspace.js';
import { sample } from './helpers.mjs';

test('saved documents contain the portable contract, not connection settings', () => {
  const item = nextScenario({ ...sample, id: 'test-id', apiKey: 'test-key', endpoint: 'https://example.com' }, null, 0, null);
  assert.equal(item.apiKey, undefined); assert.equal(item.endpoint, undefined);
  assert.equal(item.version, 1); assert.ok(item.updatedAt);
});

test('repeat saves are idempotent; stale edits and deletions do not overwrite newer work', () => {
  const original = nextScenario({ ...sample, id: 'test-id' }, null, 0, null);
  assert.deepEqual(nextScenario(original, original, 1, null), original);
  const newer = nextScenario({ ...original, title: 'Newer edit' }, original, 1, original.updatedAt);
  assert.throws(() => nextScenario({ ...original, title: 'Stale edit' }, newer, 1, original.updatedAt), /another tab/);
  assert.throws(() => nextScenario(original, null, 0, original.updatedAt), /another tab/);
});

test('library capacity permits edits but prevents another entry', () => {
  const original = nextScenario({ ...sample, id: 'test-id' }, null, 0, null);
  assert.throws(() => nextScenario({ ...sample, id: 'new-id' }, null, 100, null), /100 scenarios/);
  assert.equal(nextScenario({ ...original, title: 'Edited' }, original, 100, original.updatedAt).title, 'Edited');
});
