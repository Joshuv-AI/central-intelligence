/* NASA GIBS tile URL builder for before/after imagery comparison.
   GIBS WMTS REST template and product specs adapted from
   bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal Sidhu — see
   THIRD-PARTY-NOTICES.md): src/layers/recentImagery/model.js
   (gibsTemplate, PRODUCTS). GIBS is keyless and browser-direct.

   Only daily-global products are offered — no CMR granule search needed,
   so any date works out of the box.
*/

export const GIBS_PRODUCTS = Object.freeze({
  VIIRS: Object.freeze({
    label: 'VIIRS · daily overview',
    gibsLayer: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
    maxLevel: 9,
    format: 'jpg',
  }),
  TERRA: Object.freeze({
    label: 'MODIS Terra · true color',
    gibsLayer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    maxLevel: 9,
    format: 'jpg',
  }),
  AQUA: Object.freeze({
    label: 'MODIS Aqua · true color',
    gibsLayer: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
    maxLevel: 9,
    format: 'jpg',
  }),
});

export const GIBS_CREDIT = 'Imagery: NASA GIBS (MODIS / VIIRS)';

/**
 * GIBS WMTS REST template. y precedes x in the GIBS path; {s} rotates
 * subdomains a/b/c (pass subdomains: 'abc' to UrlTemplateImageryProvider).
 * @param {string} product key of GIBS_PRODUCTS
 * @param {string} day 'YYYY-MM-DD'
 */
export function gibsTemplate(product, day) {
  const spec = GIBS_PRODUCTS[product];
  if (!spec) throw new TypeError(`Unknown GIBS product: ${product}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError(`Bad day: ${day}`);
  return (
    `https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best/${spec.gibsLayer}` +
    `/default/${day}/GoogleMapsCompatible_Level${spec.maxLevel}/{z}/{y}/{x}.${spec.format}`
  );
}

/** 'YYYY-MM-DD' for a UTC date offset by n days. */
export function dayString(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}
