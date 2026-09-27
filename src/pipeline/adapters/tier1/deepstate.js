// Central Intelligence — DeepState (deepstatemap.live).
// Ukrainian OSINT frontline map. Keyless, no official API docs; endpoints
// are unstable, so each is tried in order and the first that works wins.
"use strict";

const crypto = require("node:crypto");

const UA = "Central-Intelligence/1.0";
const MAP_URL = "https://deepstatemap.live";
const ENDPOINTS = [
  `${MAP_URL}/en/data`,
  `${MAP_URL}/data`,
  `${MAP_URL}/api/v2/updates`,
  `${MAP_URL}/updates`,
  "https://raw.githubusercontent.com/roicastr/deepstate-data/main/data.json",
  "https://raw.githubusercontent.com/AndrewPermer/deepstate-map-data/main/data.json",
];

function tryFetch(url, ms = 20000) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), ms); });
  return Promise.race([fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, }, timer__dl)])
    .then((res) => {
      if (!res.ok) return null;
      return res.json().catch(() => null);
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer__t));
}

function stableId(obj) {
  return `deepstate-${crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 12)}`;
}

function centroid(geom) {
  if (!geom) return null;
  if (geom.type === "Point" && Array.isArray(geom.coordinates)) {
    const [lon, lat] = geom.coordinates;
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  }
  if (geom.type === "Polygon" && Array.isArray(geom.coordinates?.[0])) {
    let x = 0, y = 0, n = 0;
    for (const [lon, lat] of geom.coordinates[0]) {
      if (Number.isFinite(lon) && Number.isFinite(lat)) { x += lon; y += lat; n += 1; }
    }
    return n ? { lon: x / n, lat: y / n } : null;
  }
  if (geom.type === "LineString" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
    const mid = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    return Array.isArray(mid) ? { lon: mid[0], lat: mid[1] } : null;
  }
  return null;
}

function parseTime(v) {
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
}

function featureRecord(f, idx) {
  const props = (f && f.properties) || {};
  const geom = (f && f.geometry) || {};
  const control = String(props.control ?? props.flag ?? props.color ?? "unknown").toLowerCase();
  const name = String(props.name || props.description || props.title || `${geom.type || "position"} #${idx}`).slice(0, 100);
  const side = /russia|\bru\b|red/.test(control) ? "Russian" : /ukraine|\bua\b|blue/.test(control) ? "Ukrainian" : null;
  const c = centroid(geom);
  const lat = c && Number.isFinite(c.lat) ? c.lat : null;
  const lon = c && Number.isFinite(c.lon) ? c.lon : null;
  return {
    id: stableId({ n: name, c: control, g: JSON.stringify(geom.coordinates || []).slice(0, 200) }),
    title: `${side ? `${side} frontline position` : "Frontline position"} — ${name}`,
    summary: props.notes
      ? String(props.notes).slice(0, 200)
      : `Frontline ${geom.type || "feature"} (${control === "unknown" ? "control unknown" : control}) per DeepState map.`,
    lat,
    lon,
    region: "Ukraine",
    time: parseTime(props.date || props.updated || props.updated_at || Date.now()),
    severity: "moderate",
    url: MAP_URL,
    attribution: "DeepState",
  };
}

module.exports = {
  name: "deepstate",
  description: "DeepState — Ukraine frontline positions and control lines",
  async fetch() {
    try {
      let data = null;
      for (const url of ENDPOINTS) {
        data = await tryFetch(url);
        if (data) break;
      }
      if (!data) return [];

      let features = [];
      if (Array.isArray(data.features)) features = data.features;
      else if (Array.isArray(data.data)) features = data.data;
      else if (data.data && Array.isArray(data.data.features)) features = data.data.features;
      if (!features.length) return [];

      return features.slice(0, 40).map(featureRecord).filter(Boolean);
    } catch {
      return [];
    }
  },
};
