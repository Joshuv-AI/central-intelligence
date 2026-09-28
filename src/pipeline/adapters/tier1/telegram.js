// Telegram — keyless public-channel scraping (https://t.me/s/{channel}).
// Emits one event per recent post from curated OSINT/conflict channels.
'use strict';

const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;
const POSTS_PER_CHANNEL = 5;

const DEFAULT_CHANNELS = [
  { id: 'intelslava',        label: 'Intel Slava Z',       region: 'Ukraine' },
  { id: 'legitimniy',        label: 'Legitimniy',          region: 'Ukraine' },
  { id: 'wartranslated',     label: 'War Translated',      region: 'Ukraine' },
  { id: 'ukraine_frontline', label: 'Ukraine Frontline',   region: 'Ukraine' },
  { id: 'DeepStateUA',       label: 'DeepState Ukraine',   region: 'Ukraine' },
  { id: 'operativnoZSU',     label: 'ZSU Operative',       region: 'Ukraine' },
  { id: 'GeneralStaffZSU',   label: 'General Staff ZSU',   region: 'Ukraine' },
  { id: 'mod_russia',        label: 'Russian MoD',         region: 'Ukraine' },
  { id: 'RVvoenkor',         label: 'Voenkor RV',          region: 'Ukraine' },
  { id: 'readovkanews',      label: 'Readovka',            region: 'Ukraine' },
  { id: 'CIG_telegram',      label: 'Conflict Intel Team', region: 'Global' },
  { id: 'middleeastosint',   label: 'Middle East OSINT',   region: 'Middle East' },
  { id: 'inikiforv',         label: 'Nikiforov OSINT',     region: 'Global' },
  { id: 'geaborning',        label: 'Geo A. Borning',      region: 'Global' },
  { id: 'TheIntelligencer',  label: 'The Intelligencer',   region: 'Global' },
];

const URGENT = ['breaking', 'urgent', 'confirmed', 'missile', 'strike', 'airstrike', 'drone',
  'explosion', 'shelling', 'intercept', 'nuclear', 'ceasefire', 'offensive', 'mobilization',
  'coup', 'assassination', 'blockade', 'ultimatum', 'evacuation', 'blackout', 'cyberattack'];

// Channel region -> approximate map anchor. Posts without a meaningful region
// stay non-geographic (they still appear in the feed and layer counts).
const REGION_COORDS = {
  'Ukraine': [48.8, 31.5],      // central Ukraine
  'Middle East': [26.0, 43.5],  // central Middle East
};

// Deterministic per-post jitter so same-region markers don't stack on one point.
function jitter(id, lat, lon) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  const u = ((h >>> 0) % 1000) / 1000;
  const v = (((h >>> 10) % 1000)) / 1000;
  return [lat + (u - 0.5) * 8, lon + (v - 0.5) * 10];
}

function channels() {
  const env = (process.env.TELEGRAM_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (env.length) return env.map(id => ({ id, label: id, region: 'Global' }));
  return DEFAULT_CHANNELS;
}

async function fetchHTML(url) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, { headers: { 'User-Agent': UA } }), timer__dl]);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(timer__t); }
}

function cleanText(htmlFrag) {
  return htmlFrag
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d{1,7});/g, (_, c) => String.fromCodePoint(Math.min(+c, 0x10FFFF)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ').trim();
}

function parsePosts(html, channelId) {
  const posts = [];
  const re = /data-post="([^"]+)"([\s\S]*?)(?=data-post="|$)/gi;
  let m;
  while ((m = re.exec(html)) !== null && posts.length < POSTS_PER_CHANNEL) {
    const [, postId, block] = m;
    const textMatch = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const text = textMatch ? cleanText(textMatch[1]).slice(0, 400) : '';
    const hasMedia = /tgme_widget_message_photo|tgme_widget_message_video/i.test(block);
    if (!text && !hasMedia) continue;
    const timeMatch = block.match(/datetime="([^"]+)"/i);
    posts.push({
      postId, text: text || '[media post]',
      time: timeMatch ? new Date(timeMatch[1]).toISOString() : new Date().toISOString(),
      url: `https://t.me/${postId}`,
    });
  }
  return posts;
}

async function scrapeChannel(ch) {
  const html = await fetchHTML(`https://t.me/s/${ch.id}`);
  if (!html) return [];
  return parsePosts(html, ch.id).map(p => {
    const lower = p.text.toLowerCase();
    const anchor = REGION_COORDS[ch.region];
    const [lat, lon] = anchor ? jitter(p.postId, anchor[0], anchor[1]) : [null, null];
    return {
      id: `telegram:${p.postId}`,
      title: `[${ch.label}] ${p.text.slice(0, 80)}`.trim(),
      summary: p.text.length > 80 ? p.text.slice(80, 320).trim() || null : null,
      lat, lon,
      region: ch.region,
      time: p.time,
      severity: URGENT.some(k => lower.includes(k)) ? 'high' : 'low',
      url: p.url,
      attribution: 'Telegram OSINT',
    };
  });
}

module.exports = {
  name: 'telegram',
  description: 'Public Telegram OSINT/conflict channel posts',
  async fetch() {
    try {
      const chans = channels();
      const events = [];
      for (let i = 0; i < chans.length; i += 4) {
        const batch = await Promise.all(chans.slice(i, i + 4).map(scrapeChannel));
        for (const b of batch) events.push(...b);
      }
      return events;
    } catch {
      return [];
    }
  },
};
