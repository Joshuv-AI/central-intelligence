import * as Cesium from 'cesium';

export function createController({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  function _flightQuery(viewer) {
    const cartographic = viewer?.camera?.positionCartographic;
    if (!cartographic) return {};
    // Adapter radius (ARCH §4.2 #2): nautical miles, capped at the
    // adapter's 250. Sized to the camera height so a metro view does not
    // pull a continent of traffic it cannot render (§L B3 density).
    const heightKm = Math.max(0, cartographic.height / 1000);
    const dist = Math.min(250, Math.max(25, Math.ceil(heightKm * 0.8)));
    return {
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      dist,
    };
  }
  return { _abortActiveUpdates, _flightQuery };
}
