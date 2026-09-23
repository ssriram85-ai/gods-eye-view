import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { createWaterRendering } from './rendering.js';
import {
  WATER_LAYER_ID,
  WATER_SOURCE_LABEL,
  WATER_CATEGORIES,
  WATER_CATEGORY_ORDER,
  WATER_LIST_LIMIT,
  WATER_DEFAULT_FILTER,
  MAX_VIEWPORT_DEGREES,
  QUERY_REUSE_MS,
  REQUEST_DEBOUNCE_MS,
  boxContains,
  boxSpanDegrees,
  countByCategory,
  filterRecords,
  normalizeFilter,
  recordRowText,
  recordSummary,
  snapBox,
} from './model.js';
export * from './model.js';
export { createWaterHazardSource } from './source.js';

const ZOOM_HINT = 'Zoom in to a city or district to load mapped water bodies';
const INFO_TITLE =
  'Water bodies where drownings are most often reported, as mapped by OpenStreetMap contributors: quarry pits, irrigation tanks (eri), lakes, ponds, reservoirs and beaches. Loaded for the current view only, city scale at most. This is community mapping, not a verified drowning-site register or an official hazard list; coverage and tags vary. Select a site on the map or in the list; the list moves the camera.';

/**
 * Compute the ground box under the camera; null when the view is wider than
 * a city or is not looking at the globe.
 */
export function viewportBox(viewer, cesium = Cesium) {
  const camera = viewer?.camera;
  const canvas = viewer?.scene?.canvas;
  if (typeof camera?.pickEllipsoid !== 'function' || !canvas) return null;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (!width || !height) return null;
  const focus = camera.pickEllipsoid(
    new cesium.Cartesian2(width / 2, height / 2),
    viewer.scene.globe.ellipsoid,
  );
  if (!focus) return null;
  const location = cesium.Cartographic.fromCartesian(focus);
  const range = cesium.Cartesian3.distance(camera.positionWC, focus);
  const radius = Math.max(1000, 1.5 * range);
  const latitude = cesium.Math.toDegrees(location.latitude);
  const longitude = cesium.Math.toDegrees(location.longitude);
  const latSpan = radius / 111_000;
  const lonSpan = latSpan / Math.max(0.2, Math.cos(location.latitude));
  if (
    !Number.isFinite(latSpan + lonSpan) ||
    2 * Math.max(latSpan, lonSpan) > MAX_VIEWPORT_DEGREES ||
    Math.abs(latitude) + latSpan > 90 ||
    Math.abs(longitude) + lonSpan > 180
  )
    return null;
  return {
    south: latitude - latSpan,
    west: longitude - lonSpan,
    north: latitude + latSpan,
    east: longitude + lonSpan,
  };
}

/** Viewport-driven OSM water hazards; one bounded Overpass query per snapped view. */
export function createWaterHazardsLayer({
  source,
  cesium = Cesium,
  createRendering = createWaterRendering,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openLink = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  now = () => Date.now(),
  getViewportBox = viewportBox,
} = {}) {
  if (typeof source?.fetch !== 'function')
    throw new TypeError('Water hazards require a bounded record source');
  let viewer = null,
    rendering = null,
    request = null,
    listener = null,
    selectedId = null,
    navigationGeneration = 0,
    clickHandler = null,
    runNavigation = null,
    moveEndRemove = null,
    debounceTimer = null;
  let enabled = false,
    loading = false,
    error = null,
    destroyed = false,
    stale = false,
    saturated = false,
    tooWide = false;
  let filter = WATER_DEFAULT_FILTER;
  let records = [];
  let visible = [];
  let queryBox = null,
    queriedAt = 0,
    lastUpdate = null,
    pending = null;
  const notify = () => listener?.();
  const selected = () => visible.find((r) => r.id === selectedId) || null;
  function select(id) {
    if (selectedId !== id) ++navigationGeneration;
    selectedId = id;
    rendering?.setSelection(id);
  }
  const isSurfacePick = (picked) =>
    !picked ||
    (picked.id === undefined &&
      (picked.content !== undefined ||
        (typeof cesium.Cesium3DTileset === 'function' &&
          picked.primitive instanceof cesium.Cesium3DTileset)));
  function installSelection() {
    if (
      clickHandler ||
      !viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler = owner;
    owner.setInputAction((click) => {
      if (
        !enabled ||
        destroyed ||
        clickHandler !== owner ||
        !isPointerFree() ||
        !click?.position
      )
        return;
      const picked = viewer.scene.pick(click.position);
      const id = rendering?.pickRecord(picked);
      if (id) layer.setParams({ siteId: id });
      else if (isSurfacePick(picked)) layer.setParams({ clear: true });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function removeSelection() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }
  async function apply(controller) {
    visible = filterRecords(records, filter);
    const applied = await rendering.setSnapshot(visible, {
      signal: controller?.signal,
    });
    if (!applied) return false;
    if (!visible.some((r) => r.id === selectedId)) select(null);
    else rendering.setSelection(selectedId);
    return true;
  }
  /** Fetch for the current view unless the last query still covers it. */
  async function load({ signal, force = false } = {}) {
    if (!enabled || destroyed || !viewer) return false;
    const box = getViewportBox(viewer, cesium);
    if (!box) {
      tooWide = true;
      request?.abort();
      request = null;
      loading = false;
      records = [];
      visible = [];
      queryBox = null;
      selectedId = null;
      rendering?.clear();
      notify();
      return true;
    }
    tooWide = false;
    if (
      !force &&
      queryBox &&
      boxContains(queryBox, box) &&
      now() - queriedAt < QUERY_REUSE_MS
    )
      return false;
    const snapped = snapBox(box);
    if (boxSpanDegrees(snapped) > MAX_VIEWPORT_DEGREES + 0.2) {
      tooWide = true;
      notify();
      return true;
    }
    // A settle after enable asks for the box already in flight: join it
    // rather than aborting it, so the first update never reports failure
    // because the camera coasted a few pixels.
    if (
      request &&
      pending &&
      pending.box.south === snapped.south &&
      pending.box.west === snapped.west &&
      pending.box.north === snapped.north &&
      pending.box.east === snapped.east
    )
      return pending.promise;
    request?.abort();
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    request = controller;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    loading = true;
    notify();
    const promise = (async () => {
      try {
        signal?.throwIfAborted();
        const result = await source.fetch(snapped, controller.signal);
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        records = result.records;
        stale = Boolean(result.stale);
        saturated = Boolean(result.saturated);
        queryBox = snapped;
        queriedAt = now();
        lastUpdate = now();
        const applied = await apply(controller);
        if (!applied || controller.signal.aborted || request !== controller)
          return false;
        error = null;
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        console.warn('[Data:WaterHazards] Load error:', cause);
        error = cause?.message || 'Water hazards unavailable';
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          pending = null;
          loading = false;
          notify();
        }
      }
    })();
    pending = { box: snapped, promise };
    return promise;
  }
  function scheduleLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      load().catch(() => {});
    }, REQUEST_DEBOUNCE_MS);
  }
  const layer = {
    id: WATER_LAYER_ID,
    name: 'Water hazards · drowning risk',
    icon: '≈',
    source: WATER_SOURCE_LABEL,
    updateInterval: 600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium });
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      notify();
    },
    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      registerPickOwner(
        WATER_LAYER_ID,
        (id) => enabled && rendering?.ownsPickId?.(id) === true,
      );
      installSelection();
      if (viewer?.camera?.moveEnd?.addEventListener && !moveEndRemove)
        moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    },
    disable() {
      enabled = false;
      unregisterPickOwner(WATER_LAYER_ID);
      removeSelection();
      moveEndRemove?.();
      moveEndRemove = null;
      clearTimeout(debounceTimer);
      debounceTimer = null;
      request?.abort();
      request = null;
      pending = null;
      loading = false;
      error = null;
      stale = false;
      saturated = false;
      tooWide = false;
      records = [];
      visible = [];
      queryBox = null;
      selectedId = null;
      ++navigationGeneration;
      rendering?.clear();
    },
    async update(_viewer, { signal } = {}) {
      // The manager treats a false first update as a failed enable. A load
      // superseded by a newer view is not a failure; only a disabled or
      // destroyed layer declines.
      await load({ signal });
      return enabled && !destroyed;
    },
    setParams(params = {}) {
      if (!enabled || destroyed) return;
      if (typeof params.filter === 'string') {
        const next = normalizeFilter(params.filter);
        if (next !== filter) {
          filter = next;
          if (rendering)
            apply(null)
              .catch((cause) => {
                error = cause?.message || 'Water hazards unavailable';
              })
              .finally(notify);
        }
      }
      if (params.reload === true) load({ force: true }).catch(() => {});
      if (params.clear === true || params.siteId === null) {
        select(null);
        notify();
      } else if (
        typeof params.siteId === 'string' &&
        visible.some((r) => r.id === params.siteId)
      ) {
        select(params.siteId);
        notify();
      }
      const record = selected();
      if (params.focus === true && record && runNavigation) {
        const sphere = rendering.getFocusSphere(record.id);
        if (sphere) {
          const generation = ++navigationGeneration;
          runNavigation(() => {
            if (
              !enabled ||
              destroyed ||
              generation !== navigationGeneration ||
              selectedId !== record.id
            )
              return;
            return viewer.camera.flyToBoundingSphere(sphere, {
              duration: matchMedia?.('(prefers-reduced-motion: reduce)')
                ?.matches
                ? 0
                : 1.2,
            });
          });
        }
      }
      if (params.osm === true && record?.osmUrl) openLink(record.osmUrl);
    },
    getParams() {
      return { filter, siteId: selectedId };
    },
    getRowControls() {
      const record = selected();
      const counts = countByCategory(visible);
      const status =
        error ||
        (tooWide
          ? ZOOM_HINT
          : loading
            ? 'Loading mapped water bodies…'
            : stale
              ? 'Cached Overpass answer · mirrors unavailable'
              : saturated
                ? 'Query limit reached · zoom in for complete coverage'
                : null);
      const detail = tooWide
        ? ZOOM_HINT
        : queryBox
          ? visible.length
            ? `${visible.length} mapped site${visible.length === 1 ? '' : 's'} in view${filter === 'all' ? '' : ` · ${WATER_CATEGORIES[filter].chip.toLowerCase()}`}`
            : 'No mapped water bodies in this view'
          : loading
            ? 'Loading mapped water bodies…'
            : 'Move the camera over a city to load';
      return {
        readout: false,
        list: {
          ariaLabel: 'Mapped water bodies in view',
          items: visible.slice(0, WATER_LIST_LIMIT).map((item, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: WATER_CATEGORIES[item.category].label
              .slice(0, 3)
              .toUpperCase(),
            text: recordRowText(item),
            active: item.id === selectedId,
            params: { siteId: item.id, focus: true },
          })),
        },
        chips: [
          {
            id: 'filter-all',
            label: 'ALL',
            title: 'Every mapped category',
            active: filter === 'all',
            params: { filter: 'all' },
          },
          ...WATER_CATEGORY_ORDER.map((id) => ({
            id: `filter-${id}`,
            label: WATER_CATEGORIES[id].chip,
            title: WATER_CATEGORIES[id].blurb,
            active: filter === id,
            params: { filter: id },
          })),
          {
            id: 'reload',
            label: 'RELOAD VIEW',
            title: 'Query OpenStreetMap again for the current view',
            disabled: loading || tooWide,
            params: { reload: true },
          },
        ],
        legend: WATER_CATEGORY_ORDER.filter((id) => counts[id]).map((id) => ({
          label: WATER_CATEGORIES[id].label,
          color: WATER_CATEGORIES[id].color,
          count: counts[id],
          blurb: WATER_CATEGORIES[id].blurb,
        })),
        info: record
          ? `${recordSummary(record)}${status ? '\n' + status : ''}`
          : `${detail}${status && status !== detail ? '\n' + status : ''}`,
        infoTitle: INFO_TITLE,
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: visible.length,
        lastUpdate,
        loading,
        error,
        stale,
        source: WATER_SOURCE_LABEL,
        empty: Boolean(queryBox && !visible.length),
        statusMessage: tooWide ? ZOOM_HINT : undefined,
      };
    },
    getDiagnostics() {
      return {
        ...rendering?.getDiagnostics(),
        enabled,
        loading,
        requestPending: !!request,
        selectionActive: clickHandler !== null,
        selectedId,
        filter,
        tooWide,
        queryBox,
        timerActive: debounceTimer !== null,
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
      runNavigation = null;
    },
  };
  return layer;
}
