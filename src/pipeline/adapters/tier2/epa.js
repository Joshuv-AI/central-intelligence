// EPA Toxics Release Inventory (TRI) — one-time (non-routine) chemical
// release events. Keyless via the Envirofacts DMAP REST service
// (data.epa.gov). The old tri_data.csv endpoint is retired; TRI now lives
// in the TRI_REPORTING_FORM table, filtered server-side to the latest
// reporting year and substantial one-time release quantities, then joined
// against TRI_FACILITY for names and coordinates.
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;
const FORM_BASE = 'https://data.epa.gov/dmapservice/tri.tri_reporting_form';
const FAC_BASE = 'https://data.epa.gov/dmapservice/tri.tri_facility';

async function fetchJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const res = await Promise.race([fetch(url, { headers: { 'User-Agent': UA }, }, t__dl)]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

// TRI publishes ~July each year; find the most recent year with data.
async function latestYear() {
  for (const yr of [2026, 2025, 2024, 2023]) {
    const d = await fetchJson(`${FORM_BASE}/reporting_year/equals/${yr}/1:1/JSON`);
    if (Array.isArray(d) && d.length) return yr;
  }
  return null;
}

module.exports = {
  name: 'epa',
  description: 'EPA TRI — largest one-time toxic chemical release events',
  async fetch() {
    try {
      const yr = await latestYear();
      if (!yr) return [];
      const rows = await fetchJson(
        `${FORM_BASE}/reporting_year/equals/${yr}/and/one_time_release_qty/greaterThan/500/1:40/JSON`
      );
      if (!Array.isArray(rows) || !rows.length) return [];
      const top = rows
        .map(r => ({ r, qty: parseFloat(r.one_time_release_qty) || 0 }))
        .filter(x => x.qty > 0 && x.r.tri_facility_id)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 15);
      if (!top.length) return [];
      const ids = [...new Set(top.map(x => x.r.tri_facility_id))];
      const facs = await fetchJson(`${FAC_BASE}/tri_facility_id/in/${ids.join(',')}/1:${ids.length}/JSON`);
      const facMap = {};
      if (Array.isArray(facs)) for (const f of facs) facMap[f.tri_facility_id] = f;
      const now = new Date().toISOString();
      return top.map(({ r, qty }) => {
        const f = facMap[r.tri_facility_id] || {};
        const rawLat = parseFloat(f.pref_latitude ?? f.fac_latitude);
        const rawLon = parseFloat(f.pref_longitude ?? f.fac_longitude);
        // TRI facility coordinates are scaled integers (÷10000); longitudes
        // are stored positive — TRI is US-only, so negate for W hemisphere.
        const lat = Number.isFinite(rawLat) ? (Math.abs(rawLat) > 90 ? rawLat / 10000 : rawLat) : NaN;
        let lon = Number.isFinite(rawLon) ? (Math.abs(rawLon) > 180 ? rawLon / 10000 : rawLon) : NaN;
        if (Number.isFinite(lon)) lon = -Math.abs(lon);
        const chem = String(r.cas_chem_name || 'chemical').trim();
        const fname = String(f.facility_name || r.tri_facility_id).trim();
        const place = [f.city_name, f.state_abbr].filter(Boolean).join(', ');
        const lbs = Math.round(qty).toLocaleString('en-US');
        return {
          id: `epa-tri-${yr}-${String(r.tri_facility_id).toLowerCase()}-${String(r.tri_chem_id || 'x').toLowerCase()}`,
          title: `One-time toxic release: ${chem} — ${fname}`,
          summary: `${lbs} lbs of ${chem} released in a one-time (non-routine) event at ${fname}${place ? ` in ${place}` : ''}, per EPA Toxics Release Inventory ${yr} data.`,
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
          region: f.state_abbr || null,
          time: now,
          severity: qty >= 50000 ? 'high' : qty >= 5000 ? 'moderate' : 'low',
          url: `https://enviro.epa.gov/facts/tri/ef-facilities.html?facility_uin=${encodeURIComponent(r.tri_facility_id)}`,
          attribution: 'EPA',
        };
      });
    } catch {
      return [];
    }
  },
};
