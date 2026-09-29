/* NASA GIBS before/after imagery comparison for damage/change assessment.
   Ownership-lease pattern adapted from bilawalsidhu/gods-eye-view (MIT,
   © 2026 Bilawal Sidhu — see THIRD-PARTY-NOTICES.md):
   src/maps/imageryComparison.js (acquireImageryComparison, one-lease rule,
   idempotent restore-on-release).

   GEV's lease works against a map-stack controller; CI has a single Esri
   basemap stack, so the lease snapshots the live imageryLayers collection
   instead: on acquire it hides the base layers and drapes two GIBS date
   layers (before on the LEFT of the swipe, after on the RIGHT); on release
   it removes the GIBS layers and restores every base layer's exact show
   state. The comparison can never corrupt the user's basemap.

   Usage:
     import { startComparison } from './globe/imageryCompare/index.js';
     const cmp = startComparison(viewer, { beforeDay: '2026-08-29', afterDay: '2026-09-28' });
     cmp.setDates('2026-08-01', '2026-09-28');
     cmp.close(); // restores the exact prior basemap
*/
import * as Cesium from 'cesium';
import { GIBS_PRODUCTS, GIBS_CREDIT, gibsTemplate, dayString } from './gibs.js';

let activeLease = null;

/**
 * Lease the map for an imagery comparison. One lease at a time — acquiring
 * while another owner holds it throws synchronously. Release is idempotent
 * and restores the base layers' exact show states.
 */
export function acquireImageryComparison(viewer, { owner = 'imagery-comparison' } = {}) {
  if (!viewer) throw new Error('Imagery comparison needs a viewer');
  if (activeLease) {
    throw new Error(
      activeLease.releasing
        ? `Imagery comparison still held by ${activeLease.owner} until release settles`
        : `Imagery comparison already held by ${activeLease.owner}`,
    );
  }
  const layers = viewer.imageryLayers;
  const snapshot = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers.get(i);
    snapshot.push({ layer, show: layer.show });
    layer.show = false;
  }
  const lease = {
    owner,
    releasing: false,
    released: false,
    addedLayers: [],
    priorSplit: viewer.scene.imagerySplitPosition,
    release() {
      if (lease.released) return;
      lease.released = true;
      lease.releasing = true;
      try {
        for (const layer of lease.addedLayers) {
          if (layers.contains(layer)) layers.remove(layer, false);
        }
        lease.addedLayers = [];
        for (const { layer, show } of snapshot) {
          if (layers.contains(layer)) layer.show = show;
        }
        viewer.scene.imagerySplitPosition = lease.priorSplit;
      } finally {
        lease.releasing = false;
        if (activeLease === lease) activeLease = null;
      }
    },
  };
  activeLease = lease;
  return lease;
}

function makeGibsLayer(viewer, product, day, splitDirection) {
  const spec = GIBS_PRODUCTS[product];
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: gibsTemplate(product, day),
    subdomains: 'abc',
    credit: new Cesium.Credit(GIBS_CREDIT, true),
    maximumLevel: spec.maxLevel,
    hasAlphaChannel: false,
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.splitDirection = splitDirection;
  return layer;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Open a before/after GIBS comparison over the current view.
 * @param {object} viewer Cesium viewer
 * @param {{beforeDay?: string, afterDay?: string, product?: string}} opts
 *   Defaults: before = 30 days ago, after = yesterday (GIBS lags ~1 day).
 */
export function startComparison(viewer, { beforeDay, afterDay, product = 'VIIRS' } = {}) {
  const lease = acquireImageryComparison(viewer);
  let current = {
    before: beforeDay || dayString(30),
    after: afterDay || dayString(1),
    product,
  };

  const addPair = () => {
    const before = makeGibsLayer(viewer, current.product, current.before, Cesium.ImagerySplitDirection.LEFT);
    const after = makeGibsLayer(viewer, current.product, current.after, Cesium.ImagerySplitDirection.RIGHT);
    lease.addedLayers.push(before, after);
    viewer.scene.imagerySplitPosition = 0.5;
  };
  addPair();

  const refresh = (opts) => {
    current = { ...current, ...opts };
    for (const layer of lease.addedLayers) {
      if (viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, false);
    }
    lease.addedLayers = [];
    addPair();
  };

  // —— Swipe UI ———————————————————————————————————————————————
  const container = viewer.scene.canvas.parentElement;
  const divider = el('div', 'ci-compare-divider');
  const handle = el('div', 'ci-compare-handle');
  divider.appendChild(handle);
  container.appendChild(divider);

  const positionDivider = () => {
    divider.style.left = `${viewer.scene.imagerySplitPosition * 100}%`;
  };
  positionDivider();

  let dragging = false;
  const moveTo = (clientX) => {
    const rect = container.getBoundingClientRect();
    const frac = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    viewer.scene.imagerySplitPosition = frac;
    positionDivider();
  };
  const onPointerDown = (ev) => { dragging = true; handle.setPointerCapture(ev.pointerId); };
  const onPointerMove = (ev) => { if (dragging) moveTo(ev.clientX); };
  const onPointerUp = () => { dragging = false; };
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);

  // —— Control panel —————————————————————————————————————————
  const panel = el('div', 'ci-compare-panel');
  const title = el('div', 'ci-compare-title', 'BEFORE / AFTER · NASA GIBS');
  const row = el('div', 'ci-compare-row');

  const beforeInput = el('input', 'ci-compare-date');
  beforeInput.type = 'date';
  beforeInput.value = current.before;
  beforeInput.setAttribute('aria-label', 'Before date');
  const afterInput = el('input', 'ci-compare-date');
  afterInput.type = 'date';
  afterInput.value = current.after;
  afterInput.setAttribute('aria-label', 'After date');
  const productSel = el('select', 'ci-compare-product');
  for (const [key, spec] of Object.entries(GIBS_PRODUCTS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = spec.label;
    if (key === current.product) opt.selected = true;
    productSel.appendChild(opt);
  }
  const closeBtn = el('button', 'ci-compare-close', 'CLOSE');
  closeBtn.type = 'button';

  const apply = () => {
    const b = beforeInput.value || current.before;
    const a = afterInput.value || current.after;
    if (b === current.before && a === current.after && productSel.value === current.product) return;
    if (b >= a) {
      // Honest ordering: before must predate after.
      beforeInput.value = current.before;
      afterInput.value = current.after;
      return;
    }
    refresh({ before: b, after: a, product: productSel.value });
  };
  beforeInput.addEventListener('change', apply);
  afterInput.addEventListener('change', apply);
  productSel.addEventListener('change', apply);

  row.append(beforeInput, afterInput, productSel, closeBtn);
  panel.append(title, row);
  container.appendChild(panel);

  let closed = false;
  const handleApi = {
    get beforeDay() { return current.before; },
    get afterDay() { return current.after; },
    get product() { return current.product; },
    setDates(before, after) {
      if (before) beforeInput.value = before;
      if (after) afterInput.value = after;
      apply();
    },
    setProduct(p) {
      if (GIBS_PRODUCTS[p]) { productSel.value = p; apply(); }
    },
    setSplit(frac) {
      const v = Math.max(0.02, Math.min(0.98, Number(frac) || 0.5));
      viewer.scene.imagerySplitPosition = v;
      positionDivider();
    },
    close() {
      if (closed) return;
      closed = true;
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      divider.remove();
      panel.remove();
      lease.release();
    },
  };
  closeBtn.addEventListener('click', handleApi.close);
  return handleApi;
}

/** True while a comparison holds the map lease. */
export function isComparisonActive() {
  return activeLease !== null;
}
