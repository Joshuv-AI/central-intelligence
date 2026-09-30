/* Background first-load helper for layer toggles (Joshua 2026-09-30).
   Layer toggles must feel instant: the first network fetch runs off the
   critical path, and the Layers panel is notified via a 'layer-ready'
   window event when data lands (or fails):
     new CustomEvent('layer-ready', { detail: { layer, failed } })
   Usage per layer module:
     const firstLoad = makeBackgroundLoader('quakes');
     // in setX(true): if (!dataSource) firstLoad.ensure(() => refresh());
   On failure the module should set enabled=false in its own catch (the
   helper rethrows semantics are preserved: ensure() never swallows — the
   caller passes a promise and the helper observes it). */
export function makeBackgroundLoader(layer) {
  let loading = false;
  return {
    /** True while the first fetch is in flight. */
    get loading() { return loading; },
    /**
     * Run startLoad() in the background unless already loading. Dispatches
     * 'layer-ready' (or 'layer-ready' with failed:true) exactly once when
     * the promise settles. Never throws.
     */
    ensure(startLoad) {
      if (loading) return;
      loading = true;
      Promise.resolve()
        .then(startLoad)
        .then(() => {
          loading = false;
          window.dispatchEvent(
            new CustomEvent('layer-ready', { detail: { layer } })
          );
        })
        .catch((err) => {
          loading = false;
          console.warn(`[${layer}] background load failed:`, err);
          window.dispatchEvent(
            new CustomEvent('layer-ready', { detail: { layer, failed: true } })
          );
        });
    },
  };
}
