// Central Intelligence — JSON state store on disk.
// Four files, nothing else: events, connections, feed, meta.
// No database until load proves one is needed (simplicity guardrail).
//
// Writes are atomic (temp file + rename) so a crash mid-sweep can never
// leave a half-written file. If a sweep fails, the last good state stays.
const fs = require('fs');
const path = require('path');

let feedWorthyConnection = null;
try {
  ({ feedWorthyConnection } = require('./brain'));
} catch {
  // Gate check unavailable -> keep existing story items.
}

const FILES = ['events.json', 'connections.json', 'feed.json', 'meta.json'];

class Store {
  constructor(dir, feedLimit = 60) {
    this.dir = dir;
    this.feedLimit = feedLimit;
    this.state = { events: [], connections: [], feed: [], meta: {} };
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const file of FILES) {
      const key = path.basename(file, '.json');
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf8');
        this.state[key] = JSON.parse(raw);
      } catch {
        // Missing or corrupt file -> start empty. Never crash on state.
      }
    }
    if (!Array.isArray(this.state.events)) this.state.events = [];
    if (!Array.isArray(this.state.connections)) this.state.connections = [];
    if (!Array.isArray(this.state.feed)) this.state.feed = [];
    if (!this.state.meta || typeof this.state.meta !== 'object') this.state.meta = {};
    this._pruneFeedOnce();
    return this.state;
  }

  // A v2 story item stays only while its backing connection exists in the
  // current fusion set and still meets the feed quality gate. Stories whose
  // connection churned out or never met the bar are stale noise, not news.
  _storyAlive(f, byConnId) {
    if (!f || f.kind !== 'connection' || typeof f.id !== 'string') return true;
    if (!f.id.startsWith('feed-story-')) return true;
    if (!feedWorthyConnection || !f.connectionId) return true;
    const c = byConnId.get(f.connectionId);
    return !!c && feedWorthyConnection(c);
  }

  _liveConnections() {
    return new Map((this.state.connections || []).map((c) => [c.id, c]));
  }

  // One-time cleanup on startup: drop legacy pre-story raw correlation rows
  // (feed-conn-*), anything past the 48h TTL, and story items whose
  // connection is gone or no longer meets the feed quality gate — so a fresh
  // deploy starts from a calm digest instead of a backlog of noise.
  _pruneFeedOnce() {
    const cutoff = Date.now() - 48 * 3600_000;
    const before = this.state.feed.length;
    const byConnId = this._liveConnections();
    this.state.feed = this.state.feed.filter((f) => {
      if (!f || typeof f.id !== 'string') return false;
      if (f.id.startsWith('feed-conn-')) return false;
      const t = f.time ? new Date(f.time).getTime() : 0;
      if (!(Number.isFinite(t) && t > cutoff)) return false;
      return this._storyAlive(f, byConnId);
    });
    if (this.state.feed.length !== before) {
      console.log(
        `[store] startup feed prune: ${before} -> ${this.state.feed.length}`
      );
      this._write('feed');
    }
  }

  _write(key) {
    const file = path.join(this.dir, `${key}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state[key], null, 2));
    fs.renameSync(tmp, file);
  }

  saveAll() {
    for (const file of FILES) this._write(path.basename(file, '.json'));
  }

  // Replace every event previously contributed by `source` with `events`.
  replaceSourceEvents(source, events) {
    const rest = this.state.events.filter((e) => e.source !== source);
    this.state.events = rest.concat(events);
    this._write('events');
  }

  pushFeed(items) {
    // 48h TTL: stale items age out so the feed never accumulates dead noise.
    // Stories are also re-verified against the live connection set each
    // sweep, so a story whose connection churned out disappears promptly.
    const cutoff = Date.now() - 48 * 3600_000;
    const byConnId = this._liveConnections();
    this.state.feed = items
      .concat(this.state.feed)
      .filter((f) => {
        const t = f && f.time ? new Date(f.time).getTime() : 0;
        return Number.isFinite(t) && t > cutoff;
      })
      .filter((f) => this._storyAlive(f, byConnId))
      .slice(0, this.feedLimit);
    this._write('feed');
  }

  setConnections(connections) {
    this.state.connections = connections;
    this._write('connections');
  }

  patchMeta(patch) {
    Object.assign(this.state.meta, patch);
    this._write('meta');
  }

  getEvents({ domain, region, since, severity } = {}) {
    let out = this.state.events;
    if (domain) {
      const d = String(domain).toLowerCase();
      out = out.filter((e) => e.domain === d);
    }
    if (severity) {
      const s = String(severity).toLowerCase();
      out = out.filter((e) => e.severity === s);
    }
    if (region) {
      const r = String(region).toLowerCase();
      out = out.filter((e) => e.region && e.region.toLowerCase().includes(r));
    }
    if (since) {
      const t = new Date(since).getTime();
      if (!Number.isNaN(t)) out = out.filter((e) => new Date(e.time).getTime() >= t);
    }
    return out.slice().sort((a, b) => new Date(b.time) - new Date(a.time));
  }

  snapshot() {
    return {
      markers: this.state.events,
      connections: this.state.connections,
      feed: this.state.feed,
      meta: this.state.meta,
    };
  }
}

module.exports = { Store };
