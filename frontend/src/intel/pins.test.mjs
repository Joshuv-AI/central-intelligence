import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makePin, loadPins, savePins, addPin, removePin, pinSubtitle,
  pinMatchesEvent, pinDigest, createPinWatcher, PINS_KEY, MAX_PINS,
} from './pins.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const NOW = 1_789_000_000_000;

test('makePin validates all three shapes', () => {
  assert.ok(makePin({ kind: 'region', regionId: 'europe' }).pin);
  assert.ok(makePin({ kind: 'region', regionId: 'world' }).error, 'world is not pinnable');
  assert.ok(makePin({ kind: 'point', lat: 28.5, lon: -81.4 }).pin);
  assert.ok(makePin({ kind: 'point', lat: 999, lon: 0 }).error);
  assert.ok(makePin({ kind: 'box', minLat: 20, maxLat: 30, minLon: -90, maxLon: -80 }).pin);
  assert.ok(makePin({ kind: 'box', minLat: 30, maxLat: 20, minLon: -90, maxLon: -80 }).error);
  assert.ok(makePin({ kind: 'nope' }).error);
});

test('pins persist round-trip, cap enforced', () => {
  const ls = memStorage();
  let pins = [];
  for (let i = 0; i < MAX_PINS; i++) {
    const r = addPin(pins, { kind: 'point', lat: i, lon: i }, ls);
    pins = r.pins;
    assert.ok(!r.error);
  }
  const over = addPin(pins, { kind: 'point', lat: 1, lon: 1 }, ls);
  assert.ok(over.error, 'cap enforced');
  assert.deepEqual(loadPins(ls).length, MAX_PINS);
  const removed = removePin(pins, pins[0].id, ls);
  assert.equal(loadPins(ls).length, MAX_PINS - 1);
  assert.ok(pinSubtitle(pins[1]).length > 0);
  assert.equal(loadPins(memStorage()).length, 0, 'corrupt/empty storage -> []');
  ls.setItem(PINS_KEY, 'not json');
  assert.deepEqual(loadPins(ls), []);
});

test('pinMatchesEvent: region, point radius, box', () => {
  const regionPin = makePin({ kind: 'region', regionId: 'europe' }).pin;
  assert.ok(pinMatchesEvent(regionPin, { region: 'Eastern Europe', title: 'war in ukraine' }));
  assert.ok(!pinMatchesEvent(regionPin, { region: 'Florida', title: 'storm' }));
  // events with no regional signal stay visible everywhere (old CI rule)
  assert.ok(pinMatchesEvent(regionPin, { title: 'mystery' }));

  const pointPin = makePin({ kind: 'point', lat: 28.54, lon: -81.38, radiusKm: 100 }).pin;
  assert.ok(pinMatchesEvent(pointPin, { lat: 28.6, lon: -81.3, title: 'x' }));
  assert.ok(!pinMatchesEvent(pointPin, { lat: 25.76, lon: -80.19, title: 'miami' }));
  assert.ok(!pinMatchesEvent(pointPin, { title: 'no coords' }));

  const boxPin = makePin({ kind: 'box', minLat: 20, maxLat: 30, minLon: -90, maxLon: -80 }).pin;
  assert.ok(pinMatchesEvent(boxPin, { lat: 25, lon: -85, title: 'x' }));
  assert.ok(!pinMatchesEvent(boxPin, { lat: 35, lon: -85, title: 'x' }));
});

test('pinDigest counts matching feed items in the window', () => {
  const pin = makePin({ kind: 'point', lat: 28.54, lon: -81.38, radiusKm: 200 }).pin;
  const feed = [
    { id: 'f1', headline: 'Storm near Orlando', lat: 28.6, lon: -81.3, time: new Date(NOW - 3600_000).toISOString(), severity: 'high', kind: 'event' },
    { id: 'f2', headline: 'Quake in Japan', lat: 35, lon: 139, time: new Date(NOW - 3600_000).toISOString(), severity: 'high', kind: 'event' },
    { id: 'f3', headline: 'Old news', lat: 28.6, lon: -81.3, time: new Date(NOW - 30 * 3600_000).toISOString(), severity: 'high', kind: 'event' },
  ];
  const d = pinDigest(pin, { feed }, 6 * 3600_000, NOW);
  assert.equal(d.count, 1);
  assert.equal(d.items[0].id, 'f1');
});

test('watcher alerts once per new matching item, advances lastSeenAt', () => {
  const pin = makePin({ kind: 'point', lat: 28.54, lon: -81.38, radiusKm: 200 }).pin;
  const pins = [pin];
  const feed = [
    { id: 'f1', headline: 'Storm', lat: 28.6, lon: -81.3, time: new Date(NOW - 1000).toISOString(), severity: 'high', kind: 'event' },
  ];
  const alerts = [];
  const w = createPinWatcher({
    getPins: () => pins,
    getFeed: () => feed,
    onAlert: (a) => alerts.push(a),
    onPinsChanged: () => {},
  });
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    w.check();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].items.length, 1);
    assert.equal(pin.lastSeenAt, NOW);
    w.check();
    assert.equal(alerts.length, 1, 'no re-alert on the same pulse');
    feed.push({ id: 'f2', headline: 'More', lat: 28.6, lon: -81.3, time: new Date(NOW + 1000).toISOString(), severity: 'high', kind: 'event' });
    Date.now = () => NOW + 2000;
    w.check();
    assert.equal(alerts.length, 2, 'new item alerts');
    assert.equal(alerts[1].items[0].id, 'f2');
  } finally {
    Date.now = realNow;
  }
});
