import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeFirePerimeterSnapshot } from './records.js';

/**
 * NIFC WFIGS current interagency fire perimeters (public domain, keyless),
 * queried client-direct from the ArcGIS FeatureServer — the same fixed
 * query GEV's server provider used (ARCH §6.5: perimeters are
 * client-direct in this architecture; there is no `/api/fire-perimeters`
 * route). `maxAllowableOffset` trades ~100 m of boundary fidelity for a
 * payload small enough to refresh continuously.
 */
export const WFIGS_PERIMETERS_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'poly_IncidentName',
      'attr_UniqueFireIdentifier',
      'attr_IncidentSize',
      'attr_PercentContained',
      'attr_POOState',
      'attr_IncidentTypeCategory',
      'attr_FireDiscoveryDateTime',
      'poly_DateCurrent',
      'attr_FireCause',
      'attr_FireBehaviorGeneral',
      'attr_TotalIncidentPersonnel',
      'attr_POOCounty',
      'attr_EstimatedCostToDate',
      'attr_IncidentComplexityLevel',
      'attr_CpxName',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();

// The service caps a single response at its maxRecordCount (2000); a peak
// season can exceed that, so follow exceededTransferLimit with offset pages.
const MAX_PAGES = 5;
const PAGE_LIMIT_BYTES = 16 * 1024 * 1024;

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/** Request a normalized WFIGS snapshot directly; rows out, nothing proxied. */
export function createWfigsPerimeterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const features = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const url =
          page === 0
            ? WFIGS_PERIMETERS_URL
            : `${WFIGS_PERIMETERS_URL}&resultOffset=${features.length}`;
        const response = await fetchImpl(url, { signal });
        if (!response.ok) throw new Error(`WFIGS HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          PAGE_LIMIT_BYTES,
          signal,
        );
        signal?.throwIfAborted();
        if (!Array.isArray(payload?.features))
          throw new Error('Malformed perimeter snapshot');
        features.push(...payload.features);
        if (!exceededTransferLimit(payload) || !payload.features.length)
          break;
      }
      const rows = normalizeFirePerimeterSnapshot({ features });
      if (!rows) throw new Error('Malformed perimeter snapshot');
      return rows;
    },
  };
}
