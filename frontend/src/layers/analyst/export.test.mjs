/** J4-09 · export payload — the timestamp is burned into the content. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportPayload,
  exportFileName,
  renderExportJson,
  renderExportTxt,
} from './export.js';

const EVENTS = [
  {
    id: 'e1', title: 'Quake M6.2', severity: 'high',
    time: '2026-10-13T18:00:00.000Z', region: 'Pacific', source: 'usgs',
    lat: 10, lon: 20, url: 'https://x.example/1',
  },
  {
    id: 'e2', title: 'Flood', severity: 'moderate',
    time: '2026-10-13T17:00:00.000Z', region: null, source: 'gdacs',
    lat: null, lon: null, url: null,
  },
];

test('payload burns in export time and data age', () => {
  const p = buildExportPayload({
    exportedAt: '2026-10-13T19:00:00.000Z',
    camera: { lat: 10, lon: 20, heightKm: 5000 },
    layerHash: '#layers=abc',
    events: EVENTS,
  });
  assert.equal(p.exportedAt, '2026-10-13T19:00:00.000Z');
  assert.equal(p.dataAsOf, '2026-10-13T18:00:00.000Z');
  assert.match(p.staleNote, /60 min before export/);
  assert.equal(p.eventCount, 2);
  assert.equal(p.layers, '#layers=abc');
});

test('empty events export is honest about unknown age', () => {
  const p = buildExportPayload({ events: [] });
  assert.equal(p.dataAsOf, null);
  assert.match(p.staleNote, /age unknown/);
});

test('JSON and TXT render the burned-in timestamp', () => {
  const p = buildExportPayload({ exportedAt: '2026-10-13T19:00:00.000Z', events: EVENTS });
  const json = renderExportJson(p);
  assert.match(json, /2026-10-13T19:00:00\.000Z/);
  assert.match(json, /Quake M6\.2/);
  const txt = renderExportTxt(p);
  assert.match(txt, /Exported: 2026-10-13T19:00:00\.000Z/);
  assert.match(txt, /\[HIGH\] Quake M6\.2/);
  assert.match(txt, /— end of export —/);
});

test('filenames are timestamped and extension-correct', () => {
  assert.match(exportFileName('2026-10-13T19:00:00.000Z', 'json'), /^central-intelligence-export-.*\.json$/);
  assert.match(exportFileName('2026-10-13T19:00:00.000Z', 'txt'), /\.txt$/);
});
