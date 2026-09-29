/**
 * Manual annotation drawing: the Cesium half.
 *
 * Ported from God's Eye View (MIT) `src/annotations/drawTool.js`. Draw turns
 * the globe into a whiteboard: pick a shape (area, line or pin), click the
 * vertices on the real world, double-click or press Enter to finish. The
 * finished session is handed to `onComplete` as
 * `{ reason, shape, vertices }` — the integrator decides what to do with it
 * (persist via annotationStore, render via annotationRender).
 *
 * TOUCH / MOBILE: pass `touchMode: true`. Double-tap is gesture-hostile on
 * touch (it zooms the globe and produces stray vertices), so double-click-
 * finish is disabled in touch mode; the integrator should offer a "place
 * vertex" button (calls `api.addVertexAt(center)`) and a "finish" button
 * (calls `api.finish()`), and pass a larger `minSeparationM` (~15 m) since
 * fingers are imprecise. The preview's own handler still accepts taps.
 *
 * Two ownership rules make it safe to share the scene with CI's layers:
 * - While a session is open the tool HOLDS THE POINTER (module-local
 *   claim under DRAW_POINTER_OWNER). Ambient marker-click handlers should
 *   check `pointerOwner()` and yield while the claim is held.
 * - Cesium's Viewer binds its OWN left click (select the entity under the
 *   pointer) and double click (track it) on the viewer's handler. Both are
 *   borrowed for the session and given back on the way out, and `destroy()`
 *   gives back every listener, the Cesium handler and the preview data
 *   source, so the tool can be torn down without leaving anything behind.
 *
 * No DOM controls are created here: CI owns the UI and drives this tool
 * through startDraw(shape) / finish() / cancelDraw(). The only DOM touch is a
 * window keydown listener while a session is open.
 */
import * as Cesium from 'cesium';
import {
  DRAW_SHAPES,
  MAX_VERTICES,
  MIN_VERTEX_SEPARATION_M,
  createDrawSession,
  normalizeShape,
} from './drawSession.js';

/** The id this tool claims the pointer under. */
export const DRAW_POINTER_OWNER = 'draw';
const PREVIEW_DATA_SOURCE_NAME = 'ci-draw-preview';

const PREVIEW_COLORS = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

/* ---- module-local pointer claim (CI has no shared registry yet) ---- */
let _pointerOwner = null;
/** @returns {string|null} who currently holds the pointer */
export function pointerOwner() {
  return _pointerOwner;
}
function claimPointer(owner) {
  if (_pointerOwner && _pointerOwner !== owner) return null;
  _pointerOwner = owner;
  return { owner };
}
function releasePointer(lease) {
  if (lease && _pointerOwner === lease.owner) _pointerOwner = null;
}

/**
 * Wire the draw tool.
 * @param {{
 *   viewer: Cesium.Viewer,
 *   onComplete: (result: { reason: string, shape: string, vertices: Array<[number,number]>, color?: string }) => void,
 *   onHint?: (text: string) => void,
 *   minSeparationM?: number,
 *   touchMode?: boolean,
 *   color?: string,
 * }} opts
 * @returns {{ startDraw: Function, finish: Function, cancelDraw: Function, addVertexAt: Function, destroy: Function,
 *   active: boolean, shape: string, session: object|null, pointerOwner: Function, diagnostics: Function }|null}
 */
export function initDrawTool({
  viewer,
  onComplete,
  onHint,
  minSeparationM = MIN_VERTEX_SEPARATION_M,
  touchMode = false,
  color = 'primary',
} = {}) {
  if (!viewer || typeof onComplete !== 'function') return null;

  let destroyed = false;
  let session = null;
  let shape = 'area';
  let strokeColor = color;
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let cursor = null; // last pointer world position, for the rubber band
  let generation = 0; // bumped by anything that supersedes an in-flight finish
  const previewEntities = [];
  const setHint = (text) => {
    try {
      onHint && onHint(text);
    } catch {
      /* hint sink failed — drawing must not */
    }
  };

  const dataSource = new Cesium.CustomDataSource(PREVIEW_DATA_SOURCE_NAME);
  // `add()` resolves on the NEXT tick, so an init-then-immediate-destroy would
  // remove a source that had not been attached yet and leave the attachment to
  // land afterwards — a preview data source nobody owns. Chain the removal onto
  // the attachment instead of racing it.
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );

  /* ---- preview ----------------------------------------------------- */
  const vertexPositions = () =>
    session.vertices.map((v) =>
      Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height || 0),
    );
  const previewLine = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        if (!session) return [];
        const pts = vertexPositions();
        if (cursor && session.shape !== 'pin') pts.push(cursor);
        if (session.shape === 'area' && pts.length >= 3) pts.push(pts[0]);
        return pts;
      }, false),
      width: 3,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(
          PREVIEW_COLORS.primary,
        ).withAlpha(0.9),
        dashLength: 16,
      }),
      depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(
          PREVIEW_COLORS.primary,
        ).withAlpha(0.35),
        dashLength: 16,
      }),
      clampToGround: false,
    },
  });
  const syncPreview = () => {
    if (destroyed) return;
    previewEntities.forEach((e) => dataSource.entities.remove(e));
    previewEntities.length = 0;
    if (!session) {
      previewLine.show = false;
      setHint(session?.getHint?.() ?? '');
      viewer.scene.requestRender();
      return;
    }
    const stroke = Cesium.Color.fromCssColorString(
      PREVIEW_COLORS[strokeColor] || PREVIEW_COLORS.primary,
    );
    previewLine.polyline.material = new Cesium.PolylineDashMaterialProperty({
      color: stroke.withAlpha(0.9),
      dashLength: 16,
    });
    previewLine.show = session.shape !== 'pin';
    for (const v of session.vertices) {
      previewEntities.push(
        dataSource.entities.add({
          position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height || 0),
          point: {
            pixelSize: 8,
            color: stroke,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    setHint(session.getHint());
    viewer.scene.requestRender();
  };

  /* ---- vertices from clicks ---------------------------------------- */
  // Ray-cast onto the terrain; fall back to the ellipsoid. Height is kept on
  // the vertex so the rubber band follows the surface under the pointer; the
  // pure session drops it at finish (see drawSession.js).
  const worldAt = (screenPos) => {
    try {
      const ray = viewer.camera.getPickRay(screenPos);
      if (!ray) return null;
      const hit =
        viewer.scene.globe.pick(ray, viewer.scene) ||
        viewer.camera.pickEllipsoid(screenPos, viewer.scene.globe.ellipsoid);
      if (!hit) return null;
      const carto = Cesium.Cartographic.fromCartesian(hit);
      return {
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
        height: carto.height,
      };
    } catch {
      return null;
    }
  };
  const onClick = (event) => {
    if (!session || destroyed) return;
    const p = worldAt(event.position);
    if (!p) return;
    const { added, reason } = session.addVertex(p.lon, p.lat, {
      minSeparationM,
    });
    if (added) {
      // Carry the click height on the preview vertex (session drops it).
      const last = session.vertices[session.vertices.length - 1];
      if (last) last.height = p.height || 0;
      syncPreview();
      return;
    }
    if (reason === 'full')
      setHint(
        `That shape already has ${MAX_VERTICES} points — finish it or press Backspace.`,
      );
    else if (reason === 'invalid')
      setHint('That point is off the globe — click on the world.');
  };
  const onMove = (event) => {
    if (!session || session.shape === 'pin' || destroyed) return;
    const p = worldAt(event.endPosition);
    cursor = p
      ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height || 0)
      : null;
    viewer.scene.requestRender();
  };

  /* ---- finish / cancel --------------------------------------------- */
  const finish = () => {
    if (destroyed || !session) return null;
    const attempt = generation;
    const result = session.finish();
    if (result.reason !== 'ok') {
      // 'too-few' is just "keep clicking" and the hint already says so;
      // a degenerate or off-globe shape needs to be told why it was refused.
      if (result.reason !== 'too-few') setHint(session.getHint());
      return result;
    }
    // Start a fresh session BEFORE delivering, so a second Enter or the second
    // half of a double-click cannot submit the same shape twice.
    const delivered = {
      reason: 'ok',
      shape: session.shape,
      vertices: result.vertices,
      color: strokeColor,
    };
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
    if (!destroyed && attempt === generation) {
      try {
        onComplete(delivered);
      } catch {
        /* integrator's problem, not the tool's */
      }
    }
    return delivered;
  };
  const cancelDraw = () => {
    if (!session) return;
    generation += 1;
    session.cancel();
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
  };

  /* ---- keys: only while a session is open, never while typing ------ */
  const typingElsewhere = (event) => {
    const t = event.target;
    if (!t || t === document.body || t === viewer.scene.canvas) return false;
    return (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    );
  };
  const onKey = (event) => {
    if (!session || destroyed || typingElsewhere(event)) return;
    if (event.key === 'Enter') {
      if (session.vertices.length) {
        event.preventDefault();
        finish();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (session.vertices.length) cancelDraw();
      else api.stop();
      return;
    }
    if (event.key === 'Backspace') {
      if (session.undoVertex()) {
        event.preventDefault();
        syncPreview();
      }
    }
  };

  /* ---- session on / off -------------------------------------------- */
  function bindSceneHandler() {
    if (handler) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    // In touch mode double-tap is left to the integrator's own finish button —
    // binding it here would fight pinch-zoom and drop stray vertices.
    if (!touchMode) {
      handler.setInputAction(() => {
        finish();
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
    // Cesium's Viewer binds BOTH stock click actions on its own handler: the
    // single click picks an entity into `viewer.selectedEntity`, the double
    // click tracks it. Neither goes through a layer, so neither can be fixed
    // by the pointer claim — they are borrowed outright for the session and
    // given back on the way out. Borrowing the single click is what stops a
    // vertex placed on a marker from also selecting it.
    const stock = viewer.screenSpaceEventHandler;
    savedSingleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
    savedDoubleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
      null;
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    window.addEventListener('keydown', onKey, true);
  }

  function releaseSceneHandler() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    if (savedSingleClick) {
      viewer.screenSpaceEventHandler.setInputAction(
        savedSingleClick,
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      savedSingleClick = null;
    }
    if (savedDoubleClick) {
      viewer.screenSpaceEventHandler.setInputAction(
        savedDoubleClick,
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
      savedDoubleClick = null;
    }
    window.removeEventListener('keydown', onKey, true);
  }

  function startDraw(nextShape) {
    if (destroyed) return false;
    shape = normalizeShape(nextShape || shape);
    if (!session) {
      lease = claimPointer(DRAW_POINTER_OWNER);
      if (!lease) {
        setHint(
          `${pointerOwner()} is using the pointer — close it first.`,
        );
        return false;
      }
      bindSceneHandler();
    }
    generation += 1;
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
    return true;
  }

  const api = {
    get active() {
      return Boolean(session);
    },
    get shape() {
      return shape;
    },
    get session() {
      return session;
    },
    get touchMode() {
      return touchMode;
    },
    shapes: DRAW_SHAPES,
    startDraw,
    /** Test/mobile seam: add a vertex at lon/lat as if it had been clicked. */
    addVertexAt(lon, lat, height = 0) {
      if (!session) return false;
      const r = session.addVertex(lon, lat, { minSeparationM });
      if (r.added) {
        const last = session.vertices[session.vertices.length - 1];
        if (last) last.height = height;
        syncPreview();
      }
      return r.added;
    },
    undo() {
      if (!session || !session.undoVertex()) return false;
      syncPreview();
      return true;
    },
    finish,
    cancelDraw,
    /** End the session without delivering anything. */
    stop() {
      if (!session) return;
      generation += 1;
      session = null;
      cursor = null;
      releaseSceneHandler();
      releasePointer(lease);
      lease = null;
      syncPreview();
    },
    setColor(next) {
      if (PREVIEW_COLORS[next]) {
        strokeColor = next;
        syncPreview();
      }
    },
    pointerOwner,
    /** What this tool currently holds — for teardown and leak assertions. */
    diagnostics() {
      return {
        active: Boolean(session),
        destroyed,
        sceneHandler: Boolean(handler),
        previewEntities: destroyed ? 0 : dataSource.entities.values.length,
        pointerOwner: pointerOwner(),
        // The viewer's OWN click actions. While a session is open both are
        // borrowed (absent here); after it closes both are back. A harness can
        // compare the restored functions by identity with what it captured
        // before, which is the only way to prove they were given back rather
        // than replaced.
        stockSingleClick: Boolean(
          viewer.screenSpaceEventHandler?.getInputAction?.(
            Cesium.ScreenSpaceEventType.LEFT_CLICK,
          ),
        ),
        stockDoubleClick: Boolean(
          viewer.screenSpaceEventHandler?.getInputAction?.(
            Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
          ),
        ),
      };
    },
    /** Resolves once every deferred teardown step has run. */
    whenSettled() {
      return attaching;
    },
    destroy() {
      if (destroyed) return attaching;
      // Supersede any finish still in flight before anything is torn down.
      generation += 1;
      api.stop();
      destroyed = true;
      releaseSceneHandler();
      releasePointer(lease);
      lease = null;
      previewEntities.length = 0;
      dataSource.entities.removeAll();
      // Wait for the pending add() before removing: a destroy() in the same
      // tick as init would otherwise remove nothing and let the attachment land
      // behind it.
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed — nothing to detach from */
        }
      });
      return attaching;
    },
  };
  return api;
}
