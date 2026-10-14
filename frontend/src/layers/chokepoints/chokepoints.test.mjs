/** J4-23/J4-30 — the chokepoints PD pack is real, valid data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadChokepointsPack } from './index.js';

const pack = JSON.parse(
  readFileSync(new URL('../../data/local_data/maritime_chokepoints.json', import.meta.url), 'utf8'),
);

test('pack carries a dozen named waterways with sane coordinates', () => {
  assert.equal(pack.chokepoints.length, 12);
  const ids = new Set();
  for (const c of pack.chokepoints) {
    assert.ok(c.id && !ids.has(c.id), `unique id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.name && c.name.length > 3);
    assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180);
    assert.ok(c.context && c.context.length > 10, `${c.id} has plain context`);
  }
});

test('loader filters malformed rows and returns the twelve', async () => {
  const rows = await loadChokepointsPack({});
  assert.equal(rows.length, 12);
  assert.ok(rows.some((r) => r.id === 'hormuz'));
  assert.ok(rows.some((r) => r.id === 'panama'));
});

test('pack declares public-domain provenance', () => {
  assert.match(pack.meta.license, /Public domain/i);
});
