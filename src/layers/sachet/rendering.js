import { severityColor, SACHET_SELECTED_ACCENT } from './model.js';

/**
 * @module sachet/rendering
 * @description Static Cesium entities for SACHET alert areas: a ground-clamped
 * polygon per ring tinted by CAP severity, its outline, and a centroid point.
 * Selection brightens one alert. No timers, no clock, no per-frame work.
 */
export function createSachetRendering({ viewer, cesium: C }) {
  let source = null,
    generation = 0,
    selected = null,
    destroyed = false;
  let entityAlerts = new WeakMap();
  let entityIds = new Set();
  let byAlert = new Map();
  let spheres = new Map();
  let counts = { alerts: 0, polygons: 0, unmapped: 0 };
  const white = C.Color.fromCssColorString(SACHET_SELECTED_ACCENT);
  const render = () => {
    if (!viewer.isDestroyed?.()) viewer.scene.requestRender();
  };
  function remove(value) {
    if (!value) return;
    if (!viewer.dataSources.isDestroyed?.())
      viewer.dataSources.remove(value, true);
    value.entities.removeAll();
  }
  function style(id, active) {
    const group = byAlert.get(id);
    if (!group) return;
    const color = group.color;
    for (const entity of group.polygons)
      entity.polygon.material = color.withAlpha(active ? 0.42 : 0.22);
    for (const entity of group.outlines) {
      entity.polyline.material = active ? white : color.withAlpha(0.85);
      entity.polyline.width = active ? 2.5 : 1.2;
    }
    if (group.center) {
      group.center.point.color = active ? white : color;
      group.center.point.pixelSize = active ? 11 : 8;
    }
  }
  function select(id) {
    if (selected && selected !== id) style(selected, false);
    selected = id;
    if (id) style(id, true);
    render();
  }
  return {
    async setSnapshot(alerts, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const owner = ++generation;
      const next = new C.CustomDataSource('sachet-alerts');
      const nextEntityAlerts = new WeakMap();
      const nextEntityIds = new Set();
      const nextByAlert = new Map();
      const nextSpheres = new Map();
      const nextCounts = { alerts: 0, polygons: 0, unmapped: 0 };
      const coordinate = (pair) =>
        C.Cartesian3.fromDegrees(pair[0], pair[1], 0);
      try {
        for (const alert of alerts) {
          nextCounts.alerts++;
          if (!alert.polygons.length || !alert.centroid) {
            nextCounts.unmapped++;
            continue;
          }
          const color = C.Color.fromCssColorString(
            severityColor(alert.severity),
          );
          const group = { color, polygons: [], outlines: [], center: null };
          const extent = [];
          const addEntity = (options) => {
            const entity = next.entities.add(options);
            nextEntityAlerts.set(entity, alert.id);
            nextEntityIds.add(entity.id);
            return entity;
          };
          alert.polygons.forEach((ring, index) => {
            const positions = ring.map(coordinate);
            extent.push(...positions);
            group.polygons.push(
              addEntity({
                id: `sachet:${alert.id}:area:${index}`,
                name: alert.event,
                polygon: {
                  hierarchy: new C.PolygonHierarchy(positions),
                  classificationType: C.ClassificationType.BOTH,
                  material: color.withAlpha(0.22),
                  arcType: C.ArcType.GEODESIC,
                },
              }),
            );
            group.outlines.push(
              addEntity({
                id: `sachet:${alert.id}:outline:${index}`,
                polyline: {
                  positions,
                  width: 1.2,
                  material: color.withAlpha(0.85),
                  arcType: C.ArcType.GEODESIC,
                  clampToGround: true,
                  classificationType: C.ClassificationType.BOTH,
                },
              }),
            );
            nextCounts.polygons++;
          });
          const center = C.Cartesian3.fromDegrees(
            alert.centroid.longitude,
            alert.centroid.latitude,
            0,
          );
          group.center = addEntity({
            id: `sachet:${alert.id}:center`,
            name: alert.event,
            position: center,
            point: {
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              pixelSize: 8,
              color,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
            },
          });
          const sphere = C.BoundingSphere.fromPoints(extent);
          // A district-sized alert still deserves a regional camera destination.
          sphere.radius = Math.max(sphere.radius, 60_000);
          nextSpheres.set(alert.id, sphere);
          nextByAlert.set(alert.id, group);
        }
        await viewer.dataSources.add(next);
        if (destroyed || generation !== owner || signal?.aborted) {
          remove(next);
          return false;
        }
        remove(source);
        source = next;
        entityAlerts = nextEntityAlerts;
        entityIds = nextEntityIds;
        byAlert = nextByAlert;
        spheres = nextSpheres;
        counts = nextCounts;
        if (selected && !byAlert.has(selected)) selected = null;
        select(selected);
        return true;
      } catch (error) {
        remove(next);
        if (signal?.aborted || generation !== owner || destroyed) return false;
        throw error;
      }
    },
    setSelection: select,
    ownsPickId(id) {
      return source !== null && typeof id === 'string' && entityIds.has(id);
    },
    pickAlert(picked) {
      const entity = picked?.id;
      return source && entity && typeof entity === 'object'
        ? entityAlerts.get(entity) || null
        : null;
    },
    getFocusSphere(id) {
      return spheres.get(id) || null;
    },
    clear() {
      ++generation;
      remove(source);
      source = null;
      entityAlerts = new WeakMap();
      entityIds.clear();
      byAlert.clear();
      spheres.clear();
      selected = null;
      counts = { alerts: 0, polygons: 0, unmapped: 0 };
      render();
    },
    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
    },
    getDiagnostics() {
      return {
        ...counts,
        dataSources: Number(!!source),
        entities: source?.entities.values.length || 0,
        selectedId: selected,
        timerActive: false,
      };
    },
  };
}
