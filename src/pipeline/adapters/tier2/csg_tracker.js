// Carrier Strike Group tracker via the USNI News Fleet Tracker RSS feed
// (news.usni.org, updated ~weekly, keyless). Parses the latest tracker item
// for fleet totals and per-carrier positions, emitting fleet-position
// events — situational-awareness markers, not alarms.
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;
const RSS_URL = 'https://news.usni.org/category/fleet-tracker/feed';
const CAP = 12;

const CARRIERS = [
  { name: 'USS Gerald R. Ford',       hull: 'CVN-78', homeport: 'Norfolk, VA' },
  { name: 'USS Dwight D. Eisenhower', hull: 'CVN-69', homeport: 'Norfolk, VA' },
  { name: 'USS Harry S. Truman',      hull: 'CVN-75', homeport: 'Norfolk, VA' },
  { name: 'USS Abraham Lincoln',      hull: 'CVN-72', homeport: 'San Diego, CA' },
  { name: 'USS George Washington',    hull: 'CVN-73', homeport: 'Yokosuka, Japan' },
  { name: 'USS John C. Stennis',      hull: 'CVN-74', homeport: 'San Diego, CA' },
  { name: 'USS Ronald Reagan',        hull: 'CVN-76', homeport: 'San Diego, CA' },
  { name: 'USS Theodore Roosevelt',   hull: 'CVN-71', homeport: 'San Diego, CA' },
  { name: 'USS Nimitz',               hull: 'CVN-68', homeport: 'San Diego, CA' },
  { name: 'USS Carl Vinson',          hull: 'CVN-70', homeport: 'San Diego, CA' },
  { name: 'USS George H.W. Bush',     hull: 'CVN-77', homeport: 'Norfolk, VA' },
];
// Big-deck amphibs used to fill the event list after carriers.
const AMPHIBS = [
  { name: 'USS Tripoli',      hull: 'LHA-7' },
  { name: 'USS Boxer',        hull: 'LHD-4' },
  { name: 'USS Kearsarge',    hull: 'LHD-3' },
  { name: 'USS Makin Island', hull: 'LHD-8' },
];

const HOT = ['south china sea', 'mediterranean', 'red sea', 'persian gulf', 'arabian sea', 'taiwan', 'korea', 'black sea'];
const norm = s => String(s || '').toLowerCase().replace(/[\s.]+/g, '');

const strip = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function getTag(xml, tag) {
  let m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>?`, 'i'));
  if (m) return strip(m[1]);
  m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i'));
  return m ? strip(m[1]) : '';
}

function fleetTotals(text) {
  const m = text.match(/Total Battle Force Deployed Underway\s+(\d+)(?:\s*\([^)]*\))*\s*(\d+)(?:\s*\([^)]*\))*\s*(\d+)/i);
  return m ? { battleForce: +m[1], deployed: +m[2], underway: +m[3] } : null;
}

const LOC_RES = [
  /is in port in ([A-Z][\w\s\-'.,]+?)(?=\.|$)/i,
  /is (?:currently |now )?in ([A-Z][\w\s\-'.,]+?)(?=\.|$)/i,
  /transited (?:the )?([A-Z][\w][\w\s\-']*?)(?=\.|,| on | and )/i,
  /is operating in (?:the )?([A-Z][\w\s\-']+?)(?=\.|$)/i,
  /arrived in ([A-Z][\w\s\-'.,]+?)(?=\.|$)/i,
  /port visit to ([A-Z][\w\s\-'.,]+?)(?=\.|,)/i,
  /deployed to (?:the )?([A-Z][\w\s\-']+?)(?=\.|$)/i,
  /sails? in (?:the )?([A-Z][\w][\w\s\-']*?)(?=\.|,| while)/i,
];

// Find the best position sentence for a ship across region-marked sentences.
function findPosition(sentences, ship) {
  const want = norm(ship.name.replace(/^USS\s+/i, '')), hull = ship.hull.toUpperCase();
  const RANK_WORDS = /^(Cmdr|Capt|Lt|Sgt|Adm|Gen|Col|Maj|Seaman|Airman|US|USS|USNS|Navy)\.?$/i;
  let region = null, best = null;
  for (const s of sentences) {
    const mk = s.match(/^In (?:the )?([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})/);
    if (mk) {
      const words = mk[1].trim().split(' ');
      while (words.length > 1 && RANK_WORDS.test(words[words.length - 1])) words.pop();
      region = words.join(' ');
    }
    const hit = norm(s).includes(want) || s.toUpperCase().includes(hull);
    if (!hit) continue;
    let loc = null;
    for (const re of LOC_RES) {
      const lm = s.match(re);
      if (lm && lm[1].trim().length > 2) { loc = lm[1].trim(); break; }
    }
    if (!best || (!best.location && loc)) best = { sentence: s, location: loc, region };
    if (best.location) break;
  }
  return best;
}

module.exports = {
  name: 'csg_tracker',
  description: 'USNI Fleet Tracker — carrier strike group positions',
  async fetch() {
    let t__t;
    const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
    try {
      const res = await Promise.race([fetch(RSS_URL, { headers: { 'User-Agent': UA }, }, t__dl)]);
      if (!res.ok) return [];
      const xml = await res.text();
      const im = xml.match(/<item[^>]*>([\s\S]*?)<\/item>/i);
      if (!im) return [];
      const item = im[1];
      const title = getTag(item, 'title');
      const link = getTag(item, 'link');
      const pubRaw = getTag(item, 'pubdate');
      const time = pubRaw ? new Date(pubRaw).toISOString() : new Date().toISOString();
      const dateSlug = time.slice(0, 10);
      const desc = getTag(item, 'description');
      const body = strip(getTag(item, 'encoded'));
      const sentences = body.split(/(?<=\.)\s+/);
      const events = [];

      const totals = fleetTotals(desc);
      if (totals) {
        events.push({
          id: `csg-fleet-totals-${dateSlug}`,
          title: `U.S. Navy fleet posture — ${totals.deployed} of ${totals.battleForce} ships deployed`,
          summary: `${title}: total battle force ${totals.battleForce}, ${totals.deployed} deployed, ${totals.underway} underway.`,
          lat: null, lon: null, region: 'Global',
          time, severity: 'low', url: link || null, attribution: 'USNI News',
        });
      }

      for (const ship of [...CARRIERS, ...AMPHIBS]) {
        if (events.length >= CAP) break;
        const pos = findPosition(sentences, ship);
        if (!pos) continue;
        const loc = pos.location || pos.region || 'position not stated';
        const region = pos.region || (pos.location ? pos.location.split(',').pop().trim() : null);
        const isCarrier = ship.hull.startsWith('CVN');
        const hot = region && HOT.some(h => region.toLowerCase().includes(h));
        events.push({
          id: `csg-${ship.hull.toLowerCase()}-${dateSlug}`,
          title: `${ship.name} (${ship.hull}) — ${loc}`,
          summary: `${pos.sentence.slice(0, 280)}${ship.homeport && isCarrier ? ` Homeport: ${ship.homeport}.` : ''} (${title})`,
          lat: null, lon: null,
          region: region || null,
          time,
          severity: hot ? 'moderate' : 'low',
          url: link || null,
          attribution: 'USNI News',
        });
      }
      return events;
    } catch {
      return [];
    } finally {
      clearTimeout(t__t);
    }
  },
};
