// tsunamis.js — NOAA tsunami alerts via the tsunami.gov CAP (XML) feed.
// Parses <alert> blocks; only Watch and Warning level events are surfaced:
//   Moderate (Watch) -> moderate, Severe/Extreme (Warning) -> critical.
// 'Minor' / information statements carry no public threat and are skipped.

const CAP_URL = 'https://www.tsunami.gov/events/xml/PAAQCAP.xml';
const TIMEOUT_MS = 20_000;

const SEV_MAP = {
  Extreme: { label: 'Warning', severity: 'critical' },
  Severe: { label: 'Warning', severity: 'critical' },
  Moderate: { label: 'Watch', severity: 'moderate' },
};

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseCAP(xml) {
  const events = [];
  const alertRe = /<alert[^>]*>([\s\S]*?)<\/alert>/gi;
  let match;
  while ((match = alertRe.exec(xml)) !== null) {
    const block = match[1];
    if (tag(block, 'status') !== 'Actual') continue;
    const sevInfo = SEV_MAP[tag(block, 'severity')];
    if (!sevInfo) continue; // no threat (information statement)

    const infoMatch = block.match(/<info>([\s\S]*?)<\/info>/i);
    const info = infoMatch ? infoMatch[1] : '';
    const location = tag(info, 'areaDesc') || tag(info, 'headline') || 'Unknown location';
    const eventId = tag(block, 'identifier') || `idx${match.index}`;
    const sent = tag(block, 'sent');

    let lat = null, lon = null;
    const geo = info.match(/<geocode>[\s\S]*?<valueName>UMEVTLATLON<\/valueName>[\s\S]*?<value>([^<]+)<\/value>[\s\S]*?<\/geocode>/i);
    if (geo) {
      const [la, lo] = geo[1].split(',').map(v => parseFloat(v.trim()));
      if (!Number.isNaN(la)) lat = la;
      if (!Number.isNaN(lo)) lon = lo;
    }

    const desc = (tag(info, 'description') || '').slice(0, 280);
    events.push({
      id: `tsunami_noaa_${eventId}`,
      title: `Tsunami ${sevInfo.label} — ${location}`,
      summary: desc || `Active tsunami ${sevInfo.label.toLowerCase()} issued for ${location}.`,
      lat,
      lon,
      region: location !== 'Unknown location' ? location : null,
      time: sent || new Date().toISOString(),
      severity: sevInfo.severity,
      url: 'https://www.tsunami.gov',
      attribution: 'NOAA NWS Tsunami',
    });
  }
  return events;
}

module.exports = {
  name: 'tsunamis',
  description: 'NOAA tsunami warnings and watches from tsunami.gov',
  async fetch() {
    let timer__t;
    const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
    try {
      const r = await Promise.race([fetch(CAP_URL, {
        headers: { 'User-Agent': 'Central-Intelligence/1.0', Accept: 'application/xml' },
      }, timer__dl)]);
      clearTimeout(timer__t);
      if (!r.ok) return [];
      return parseCAP(await r.text());
    } catch {
      clearTimeout(timer__t);
      return [];
    }
  },
};
