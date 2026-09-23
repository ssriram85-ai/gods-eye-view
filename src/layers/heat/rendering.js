import {
  bandColor,
  degrees,
  sampleValue,
  HEAT_SELECTED_ACCENT,
} from './model.js';

/**
 * @module heat/rendering
 * @description One point and one label per catalog city, tinted by the
 * heat-index band of the value shown in the current mode. Static entities;
 * no timers, no per-frame work.
 */
export function createHeatRendering({ viewer, cesium: C }) {
  let source = null,
    generation = 0,
    selected = null,
    destroyed = false;
  let entitySamples = new WeakMap();
  let entityIds = new Set();
  let bySample = new Map();
  let positions = new Map();
  let count = 0;
  const white = C.Color.fromCssColorString(HEAT_SELECTED_ACCENT);
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
    const group = bySample.get(id);
    if (!group) return;
    group.point.point.color = active ? white : group.color;
    group.point.point.pixelSize = active ? 14 : 10;
    group.label.label.fillColor = active ? white : group.color;
    group.label.label.scale = active ? 1.15 : 1;
  }
  function select(id) {
    if (selected && selected !== id) style(selected, false);
    selected = id;
    if (id) style(id, true);
    render();
  }
  return {
    async setSnapshot(samples, mode, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const owner = ++generation;
      const next = new C.CustomDataSource('heat-stress');
      const nextEntitySamples = new WeakMap();
      const nextEntityIds = new Set();
      const nextBySample = new Map();
      const nextPositions = new Map();
      let nextCount = 0;
      try {
        for (const sample of samples) {
          const value = sampleValue(sample, mode);
          if (value === null) continue;
          const color = C.Color.fromCssColorString(bandColor(value));
          const position = C.Cartesian3.fromDegrees(
            sample.position.longitude,
            sample.position.latitude,
            0,
          );
          const addEntity = (options) => {
            const entity = next.entities.add(options);
            nextEntitySamples.set(entity, sample.id);
            nextEntityIds.add(entity.id);
            return entity;
          };
          const point = addEntity({
            id: `heat:${sample.id}:point`,
            name: sample.name,
            position,
            point: {
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              pixelSize: 10,
              color,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
            },
          });
          const label = addEntity({
            id: `heat:${sample.id}:label`,
            position,
            label: {
              text: `${sample.name} ${degrees(value)}`,
              font: '13px "IBM Plex Mono", "SF Mono", Menlo, monospace',
              fillColor: color,
              outlineColor: C.Color.BLACK,
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new C.Cartesian2(0, -16),
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scaleByDistance: new C.NearFarScalar(200_000, 1, 6_000_000, 0.6),
            },
          });
          nextBySample.set(sample.id, { point, label, color });
          nextPositions.set(sample.id, position);
          nextCount++;
        }
        await viewer.dataSources.add(next);
        if (destroyed || generation !== owner || signal?.aborted) {
          remove(next);
          return false;
        }
        remove(source);
        source = next;
        entitySamples = nextEntitySamples;
        entityIds = nextEntityIds;
        bySample = nextBySample;
        positions = nextPositions;
        count = nextCount;
        if (selected && !bySample.has(selected)) selected = null;
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
    pickSample(picked) {
      const entity = picked?.id;
      return source && entity && typeof entity === 'object'
        ? entitySamples.get(entity) || null
        : null;
    },
    getFocusSphere(id) {
      const position = positions.get(id);
      return position ? new C.BoundingSphere(position, 60_000) : null;
    },
    clear() {
      ++generation;
      remove(source);
      source = null;
      entitySamples = new WeakMap();
      entityIds.clear();
      bySample.clear();
      positions.clear();
      selected = null;
      count = 0;
      render();
    },
    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
    },
    getDiagnostics() {
      return {
        samples: count,
        dataSources: Number(!!source),
        entities: source?.entities.values.length || 0,
        selectedId: selected,
        timerActive: false,
      };
    },
  };
}
