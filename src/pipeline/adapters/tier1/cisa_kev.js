// CISA KEV — Known Exploited Vulnerabilities catalog (no key required).
// Emits one event per vulnerability added in the last 30 days.
'use strict';

const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const THIRTY_DAYS_MS = 30 * 86400_000;

module.exports = {
  name: 'cisa_kev',
  description: 'CISA Known Exploited Vulnerabilities — recently added CVEs',
  async fetch() {
    let timer__t;
    const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
    timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
    try {
      const res = await Promise.race([fetch(KEV_URL, { headers: { 'User-Agent': UA } }), timer__dl]);
      if (!res.ok) return [];
      const data = await res.json();
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const now = Date.now();
      return (data.vulnerabilities || [])
        .filter(v => {
          const added = new Date(v.dateAdded).getTime();
          return !isNaN(added) && added >= cutoff;
        })
        .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded))
        .map(v => {
          const ransomware = v.knownRansomwareCampaignUse === 'Known';
          const due = new Date(v.dueDate).getTime();
          const overdue = !isNaN(due) && due < now;
          return {
            id: `cisa-kev:${v.cveID}`,
            title: `${v.cveID}: ${(v.vulnerabilityName || '').slice(0, 120)}`,
            summary: (v.shortDescription || '').slice(0, 400) || null,
            lat: null, lon: null,
            region: 'Global',
            time: new Date(v.dateAdded).toISOString(),
            severity: ransomware || overdue ? 'high' : 'moderate',
            url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
            attribution: 'CISA',
          };
        });
    } catch {
      return [];
    } finally {
      clearTimeout(timer__t);
    }
  },
};
