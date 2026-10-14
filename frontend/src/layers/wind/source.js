/**
 * Wind source — IMAGERY-ONLY build (ARCH D2-08 / spike R1, lane D log).
 *
 * GEV's streamline layer is inseparable from its server transformer: the
 * vendored client contract fetched a pre-decoded Float32 grid from
 * `/api/wind/manifest` + `/api/wind/grid/*.bin`, and GRIB decode
 * (eccodes-wasm) exists only in GEV's server tree. This architecture has
 * no wind data route and forbids a VM GRIB service, so this source answers
 * locally with the layer's own designed unavailable-manifest shape — the
 * same payload GEV's server returned when its upstream was down — and
 * makes no network request at all. Wind information ships as the weather
 * imagery stack (radar / clouds / lightning); the streamline slot stays
 * honestly empty until a keyless static field source exists (D2-08).
 */
export function createWindSource() {
  return {
    async getSnapshot({ signal, model = 'gfs', overlay = 'none' } = {}) {
      if (!['gfs', 'ifs'].includes(model))
        throw new Error('Unknown wind model');
      if (!['none', 'temperature', 'pressure'].includes(overlay))
        throw new Error('Unknown weather overlay');
      signal?.throwIfAborted();
      return {
        model,
        schemaVersion: 1,
        ...(overlay === 'none' ? {} : { overlay }),
        unavailable: true,
        stale: true,
        reason:
          'Wind flow lines are not available in this version: the forecast ' +
          'feed they need is not connected. Radar, cloud and lightning ' +
          'imagery are under Weather.',
      };
    },
  };
}
