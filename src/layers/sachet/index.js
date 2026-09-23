import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { createSachetRendering } from './rendering.js';
import {
  SACHET_LAYER_ID,
  SACHET_SOURCE_LABEL,
  SACHET_REGIONS,
  SACHET_SEVERITY_ORDER,
  SACHET_LIST_LIMIT,
  SACHET_DEFAULT_REGION,
  SACHET_DEFAULT_MIN_SEVERITY,
  alertRowText,
  alertSummary,
  countBySeverity,
  filterAlerts,
  normalizeMinSeverity,
  normalizeRegion,
  severityColor,
} from './model.js';
export * from './model.js';
export { createSachetSource, validateSachetSnapshot } from './source.js';

const COVERAGE =
  'India only: alerts issued through NDMA SACHET by IMD, CWC, INCOIS and State Disaster Management Authorities.';
const INFO_TITLE =
  'Official Government of India CAP alerts relayed as published. Select an alert on the map or in the list; the list moves the camera. Click empty map space to clear. Polygons are the issuing agency’s warning area, decimated for display; an alert without a polygon is counted but not drawn. Always follow the issuing authority’s own instruction.';

/**
 * NDMA SACHET alert areas with severity and region filters; selected through
 * the map or the shared row list.
 */
export function createSachetLayer({
  feed,
  cesium = Cesium,
  createRendering = createSachetRendering,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openLink = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('SACHET alerts require a snapshot source');
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
  let region = SACHET_DEFAULT_REGION;
  let minSeverity = SACHET_DEFAULT_MIN_SEVERITY;
  let visible = [];
  const notify = () => listener?.();
  const selected = () =>
    visible.find((alert) => alert.id === selectedId) || null;
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
      // Ambient selection yields to draw tools and Director; it never claims
      // the pointer, camera, or tracking state.
      if (
        !enabled ||
        destroyed ||
        clickHandler !== owner ||
        !isPointerFree() ||
        !click?.position
      )
        return;
      const picked = viewer.scene.pick(click.position);
      const id = rendering?.pickAlert(picked);
      if (id) layer.setParams({ alertId: id });
      else if (isSurfacePick(picked)) layer.setParams({ clear: true });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function removeSelection() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }
  /** Re-derive the drawn subset after a snapshot or filter change. */
  async function apply(controller) {
    visible = snapshot
      ? filterAlerts(snapshot.alerts, { region, minSeverity })
      : [];
    const applied = await rendering.setSnapshot(visible, {
      signal: controller?.signal,
    });
    if (!applied) return false;
    if (!visible.some((alert) => alert.id === selectedId)) select(null);
    else rendering.setSelection(selectedId);
    return true;
  }
  const layer = {
    id: SACHET_LAYER_ID,
    name: 'India disaster alerts',
    icon: '⚠',
    source: SACHET_SOURCE_LABEL,
    updateInterval: 300_000,
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
          SACHET_LAYER_ID,
          (id) => enabled && rendering?.ownsPickId?.(id) === true,
        );
        installSelection();
      }
    },
    disable() {
      enabled = false;
      unregisterPickOwner(SACHET_LAYER_ID);
      removeSelection();
      request?.abort();
      request = null;
      loading = false;
      error = null;
      snapshot = null;
      visible = [];
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
          visible = [];
          selectedId = null;
          ++navigationGeneration;
          error = next.reason || 'SACHET alerts unavailable';
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
        error = cause?.message || 'SACHET alerts unavailable';
        rendering?.clear();
        snapshot = null;
        visible = [];
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
      let refilter = false;
      if (typeof params.region === 'string') {
        const next = normalizeRegion(params.region);
        if (next !== region) {
          region = next;
          refilter = true;
        }
      }
      if (typeof params.minSeverity === 'string') {
        const next = normalizeMinSeverity(params.minSeverity);
        if (next !== minSeverity) {
          minSeverity = next;
          refilter = true;
        }
      }
      if (refilter && snapshot && rendering) {
        apply(null)
          .catch((cause) => {
            error = cause?.message || 'SACHET alerts unavailable';
          })
          .finally(notify);
      }
      if (params.clear === true || params.alertId === null) {
        select(null);
        notify();
      } else if (
        typeof params.alertId === 'string' &&
        visible.some((alert) => alert.id === params.alertId)
      ) {
        select(params.alertId);
        notify();
      }
      const alert = selected();
      if (params.focus === true && alert && runNavigation) {
        const sphere = rendering.getFocusSphere(alert.id);
        if (sphere) {
          const generation = ++navigationGeneration;
          runNavigation(() => {
            if (
              !enabled ||
              destroyed ||
              generation !== navigationGeneration ||
              selectedId !== alert.id
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
      if (params.official === true && alert?.capUrl) openLink(alert.capUrl);
    },
    getParams() {
      return { region, minSeverity, alertId: selectedId };
    },
    getRowControls() {
      const alert = selected();
      const counts = countBySeverity(visible);
      const total = snapshot?.alerts.length || 0;
      const status =
        error ||
        (snapshot?.stale
          ? 'Cached alerts · upstream unavailable'
          : loading
            ? 'Loading SACHET alerts…'
            : null);
      const scope = `${SACHET_REGIONS[region].label} · ${minSeverity}${minSeverity === 'Unknown' ? '' : '+'}`;
      const detail = snapshot
        ? visible.length
          ? `${visible.length} of ${total} alert${total === 1 ? '' : 's'} shown · ${scope}${snapshot.unmapped ? ` · ${snapshot.unmapped} without polygon` : ''}`
          : total
            ? `No alerts match ${scope} · ${total} active nationwide`
            : 'No active SACHET alerts'
        : loading
          ? 'Loading SACHET alerts…'
          : 'Alerts unavailable';
      const chips = [
        ...Object.values(SACHET_REGIONS).map((preset) => ({
          id: `region-${preset.id}`,
          label: preset.label,
          title: preset.box
            ? 'Alerts naming this state, or centred inside it'
            : 'Every alert in the national feed',
          active: region === preset.id,
          params: { region: preset.id },
        })),
        ...['Extreme', 'Severe', 'Moderate', 'Unknown'].map((level) => ({
          id: `min-${level.toLowerCase()}`,
          label: level === 'Unknown' ? 'ALL LEVELS' : `${level.toUpperCase()}+`,
          title:
            level === 'Unknown'
              ? 'Show every severity, including unrated'
              : `Show ${level} and more severe alerts`,
          active: minSeverity === level,
          params: { minSeverity: level },
        })),
      ];
      return {
        readout: false,
        list: {
          ariaLabel: 'Active NDMA SACHET alerts',
          items: visible.slice(0, SACHET_LIST_LIMIT).map((item, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: item.severity.slice(0, 3).toUpperCase(),
            text: alertRowText(item),
            active: item.id === selectedId,
            params: { alertId: item.id, focus: true },
          })),
        },
        chips,
        legend: SACHET_SEVERITY_ORDER.filter((level) => counts[level]).map(
          (level) => ({
            label: level,
            color: severityColor(level),
            count: counts[level],
          }),
        ),
        info: alert
          ? `${alertSummary(alert)}${status ? '\n' + status : ''}`
          : `${detail}${status ? '\n' + status : ''}\n${snapshot?.coverage || COVERAGE}`,
        infoTitle: INFO_TITLE,
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: visible.length,
        lastUpdate: snapshot?.fetchedAt || null,
        loading,
        error,
        stale: Boolean(snapshot?.stale),
        source: SACHET_SOURCE_LABEL,
        empty: Boolean(snapshot && !snapshot.unavailable && !visible.length),
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
        region,
        minSeverity,
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
