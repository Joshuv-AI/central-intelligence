import test from 'node:test';
import assert from 'node:assert/strict';
import { provenanceLine, confidenceLine, disagreementLine, bestFetchedAt } from './provenance.js';

const NOW = 1_789_000_000_000;

test('provenanceLine is source · age, stale stays visible', () => {
  assert.equal(provenanceLine({ source: 'USGS', fetchedAtMs: NOW - 12 * 60_000 }, NOW), 'USGS · 12 m ago');
  assert.equal(provenanceLine({ source: 'NWS', fetchedAtMs: NOW - 3_600_000, stale: true }, NOW), 'NWS · 1 h ago · STALE');
  assert.equal(provenanceLine({ source: 'FIRMS' }, NOW), 'FIRMS · age unknown');
  assert.equal(provenanceLine({}, NOW), 'Unknown source · age unknown');
});

test('confidenceLine only fires on real multi-source corroboration', () => {
  const conn = {
    chain: [
      { source: 'USGS', title: 'a' },
      { source: 'GDACS', title: 'b' },
      { source: 'GDACS', title: 'c' },
    ],
  };
  assert.equal(confidenceLine(conn, NOW), 'corroborated by 2 sources');
  // One source is not corroboration: render nothing, never invent a %
  assert.equal(confidenceLine({ chain: [{ source: 'USGS' }, { source: 'USGS' }] }, NOW), null);
  assert.equal(confidenceLine({ chain: [] }, NOW), null);
  assert.equal(confidenceLine(null, NOW), null);
});

test('disagreementLine shows sources side-by-side, never averaged', () => {
  assert.equal(
    disagreementLine([{ source: 'USGS', value: '6.2' }, { source: 'EMSC', value: '6.0' }]),
    'USGS says 6.2 · EMSC says 6.0',
  );
  assert.equal(disagreementLine([{ source: 'USGS', value: '6.2' }]), '');
  assert.equal(disagreementLine([]), '');
});

test('bestFetchedAt prefers explicit, never fabricates', () => {
  assert.equal(bestFetchedAt({ fetchedAtMs: 100, sweepAtMs: 200, eventTimeMs: 300 }), 100);
  assert.equal(bestFetchedAt({ sweepAtMs: 200, eventTimeMs: 300 }), 200);
  assert.equal(bestFetchedAt({ eventTimeMs: 300 }), 300);
  assert.equal(bestFetchedAt({}), null);
});

test('provenanceLine never renders "just now ago" (glitch fix)', () => {
  assert.equal(provenanceLine({ source: 'USGS', fetchedAtMs: NOW - 5_000 }, NOW), 'USGS · just now');
  assert.equal(
    provenanceLine({ source: 'USGS', fetchedAtMs: NOW - 5_000, stale: true }, NOW),
    'USGS · just now · STALE',
  );
  assert.equal(provenanceLine({ source: 'USGS', fetchedAtMs: NOW - 90_000 }, NOW), 'USGS · 1 m ago');
});
