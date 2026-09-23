import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { createHeatRendering } from './rendering.js';
import {
  HEAT_LAYER_ID,
  HEAT_SOURCE_LABEL,
  HEAT_BANDS,
  HEAT_MODES,
  HEAT_LIST_LIMIT,
  HEAT_DEFAULT_MODE,
  countByBand,
  normalizeMode,
  rankSamples,
  sampleRowText,
  sampleSummary,
  sampleValue,
  degrees,
} from './model.js';
export * from './model.js';
export {
  createHeatStressSource,
  validateHeatStressSnapshot,
} from './source.js';

const COVERAGE =
  'Fixed catalog of Indian state capitals, large cities and Tamil Nadu towns; point samples, not a continuous field.';
const INFO_TITLE =
  'Feels-like temperature (Open-Meteo apparent temperature: air temperature, humidity, wind and radiation) at catalog cities, in NOAA heat-index bands. NOW is the current observation; TODAY MAX and TOMORROW MAX are forecast feels-like maxima. The IMD flag marks cities whose forecast air maximum reaches IMD’s heat-wave temperature threshold; an actual heat-wave declaration also depends on departure from normal, which this layer does not compute. Select a city on the map or in the list; the list moves the camera.';

/** Heat stress at catalog cities, with now / today / tomorrow modes; selected through map or list. */
export function createHeatStressLayer({
  feed,
  cesium = Cesium,
  createRendering = createHeatRendering,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Heat stress requires a snapshot source');
  let viewer = null,
    rendering = null,
    snapshot = null,
    request = null,
    listener = null,
    selectedId = null,
    navigationGeneration = 0,
    clickHandler = null,
    runNavigation = null;
  let enabled = false,
    loading = false,
    error = null,
    destroyed = false;
  let mode = HEAT_DEFAULT_MODE;
  let ranked = [];
  const notify = () => listener?.();
  const selected = () => ranked.find((s) => s.id === selectedId) || null;
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
      const id = rendering?.pickSample(picked);
      if (id) layer.setParams({ cityId: id });
      else if (isSurfacePick(picked)) layer.setParams({ clear: true });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function removeSelection() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }
  async function apply(controller) {
    ranked = snapshot ? rankSamples(snapshot.samples, mode) : [];
    const applied = await rendering.setSnapshot(ranked, mode, {
      signal: controller?.signal,
    });
    if (!applied) return false;
    if (!ranked.some((s) => s.id === selectedId)) select(null);
    else rendering.setSelection(selectedId);
    return true;
  }
  const layer = {
    id: HEAT_LAYER_ID,
    name: 'Heat stress · India',
    icon: '☀',
    source: HEAT_SOURCE_LABEL,
    updateInterval: 900_000,
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
      if (!destroyed && !enabled) {
        enabled = true;
        registerPickOwner(
          HEAT_LAYER_ID,
          (id) => enabled && rendering?.ownsPickId?.(id) === true,
        );
        installSelection();
      }
    },
    disable() {
      enabled = false;
      unregisterPickOwner(HEAT_LAYER_ID);
      removeSelection();
      request?.abort();
      request = null;
      loading = false;
      error = null;
      snapshot = null;
      ranked = [];
      selectedId = null;
      ++navigationGeneration;
      rendering?.clear();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (next.unavailable) {
          rendering.clear();
          snapshot = next;
          ranked = [];
          selectedId = null;
          ++navigationGeneration;
          error = next.reason || 'Heat stress data unavailable';
          return true;
        }
        snapshot = next;
        const applied = await apply(controller);
        if (
          !applied ||
          !enabled ||
          controller.signal.aborted ||
          request !== controller
        )
          return false;
        error = null;
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        console.warn('[Data:HeatStress] Update error:', cause);
        error = cause?.message || 'Heat stress data unavailable';
        rendering?.clear();
        snapshot = null;
        ranked = [];
        selectedId = null;
        ++navigationGeneration;
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (!enabled || destroyed) return;
      if (typeof params.mode === 'string') {
        const next = normalizeMode(params.mode);
        if (next !== mode) {
          mode = next;
          if (snapshot && rendering)
            apply(null)
              .catch((cause) => {
                error = cause?.message || 'Heat stress data unavailable';
              })
              .finally(notify);
        }
      }
      if (params.clear === true || params.cityId === null) {
        select(null);
        notify();
      } else if (
        typeof params.cityId === 'string' &&
        ranked.some((s) => s.id === params.cityId)
      ) {
        select(params.cityId);
        notify();
      }
      const sample = selected();
      if (params.focus === true && sample && runNavigation) {
        const sphere = rendering.getFocusSphere(sample.id);
        if (sphere) {
          const generation = ++navigationGeneration;
          runNavigation(() => {
            if (
              !enabled ||
              destroyed ||
              generation !== navigationGeneration ||
              selectedId !== sample.id
            )
              return;
            return viewer.camera.flyToBoundingSphere(sphere, {
              duration: matchMedia?.('(prefers-reduced-motion: reduce)')
                ?.matches
                ? 0
                : 1.4,
            });
          });
        }
      }
    },
    getParams() {
      return { mode, cityId: selectedId };
    },
    getRowControls() {
      const sample = selected();
      const counts = countByBand(ranked, mode);
      const hottest = ranked[0];
      const status =
        error ||
        (snapshot?.stale
          ? 'Cached readings · upstream unavailable'
          : loading
            ? 'Loading heat stress…'
            : null);
      const detail = snapshot
        ? ranked.length
          ? `${ranked.length} cities · ${HEAT_MODES[mode].label.toLowerCase()} · hottest ${hottest.name} ${degrees(sampleValue(hottest, mode))}${snapshot.dropped ? ` · ${snapshot.dropped} without data` : ''}`
          : 'No readings'
        : loading
          ? 'Loading heat stress…'
          : 'Readings unavailable';
      return {
        readout: false,
        list: {
          ariaLabel: 'Cities by feels-like temperature, hottest first',
          items: ranked.slice(0, HEAT_LIST_LIMIT).map((item, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: degrees(sampleValue(item, mode)),
            text: sampleRowText(item, mode),
            active: item.id === selectedId,
            params: { cityId: item.id, focus: true },
          })),
        },
        chips: Object.values(HEAT_MODES).map((preset) => ({
          id: `mode-${preset.id}`,
          label: preset.label,
          title:
            preset.id === 'now'
              ? 'Current feels-like temperature'
              : `Forecast feels-like maximum for ${preset.id}`,
          active: mode === preset.id,
          params: { mode: preset.id },
        })),
        legend: HEAT_BANDS.filter((band) => counts[band.id]).map((band) => ({
          label: band.label,
          color: band.color,
          count: counts[band.id],
        })),
        info: sample
          ? `${sampleSummary(sample)}${status ? '\n' + status : ''}`
          : `${detail}${status ? '\n' + status : ''}\n${snapshot?.coverage || COVERAGE}`,
        infoTitle: INFO_TITLE,
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: ranked.length,
        lastUpdate: snapshot?.fetchedAt || null,
        loading,
        error,
        stale: Boolean(snapshot?.stale),
        source: HEAT_SOURCE_LABEL,
        empty: Boolean(snapshot && !snapshot.unavailable && !ranked.length),
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
        mode,
        timerActive: false,
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
