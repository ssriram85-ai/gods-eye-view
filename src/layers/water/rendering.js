import { categoryColor, WATER_SELECTED_ACCENT } from './model.js';

/**
 * @module water/rendering
 * @description One point per mapped water body, tinted by category, with a
 * name label that appears when the camera is close. Static entities.
 */
export function createWaterRendering({ viewer, cesium: C }) {
  let source = null,
    generation = 0,
    selected = null,
    destroyed = false;
  let entityRecords = new WeakMap();
  let entityIds = new Set();
  let byRecord = new Map();
  let positions = new Map();
  let count = 0;
  const white = C.Color.fromCssColorString(WATER_SELECTED_ACCENT);
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
    const group = byRecord.get(id);
    if (!group) return;
    group.point.point.color = active ? white : group.color;
    group.point.point.pixelSize = active ? 13 : 8;
    if (group.label) {
      group.label.label.fillColor = active ? white : group.color;
      group.label.label.distanceDisplayCondition = active
        ? undefined
        : group.labelDistance;
    }
  }
  function select(id) {
    if (selected && selected !== id) style(selected, false);
    selected = id;
    if (id) style(id, true);
    render();
  }
  return {
    async setSnapshot(records, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const owner = ++generation;
      const next = new C.CustomDataSource('water-hazards');
      const nextEntityRecords = new WeakMap();
      const nextEntityIds = new Set();
      const nextByRecord = new Map();
      const nextPositions = new Map();
      let nextCount = 0;
      try {
        for (const record of records) {
          const color = C.Color.fromCssColorString(
            categoryColor(record.category),
          );
          const position = C.Cartesian3.fromDegrees(
            record.longitude,
            record.latitude,
            0,
          );
          const addEntity = (options) => {
            const entity = next.entities.add(options);
            nextEntityRecords.set(entity, record.id);
            nextEntityIds.add(entity.id);
            return entity;
          };
          const point = addEntity({
            id: `water:${record.id}:point`,
            name: record.name || record.category,
            position,
            point: {
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              pixelSize: 8,
              color,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
            },
          });
          let label = null;
          const labelDistance = new C.DistanceDisplayCondition(0, 40_000);
          if (record.name) {
            label = addEntity({
              id: `water:${record.id}:label`,
              position,
              label: {
                text: record.name,
                font: '12px "IBM Plex Mono", "SF Mono", Menlo, monospace',
                fillColor: color,
                outlineColor: C.Color.BLACK,
                outlineWidth: 3,
                style: C.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new C.Cartesian2(0, -14),
                heightReference: C.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                distanceDisplayCondition: labelDistance,
              },
            });
          }
          nextByRecord.set(record.id, { point, label, color, labelDistance });
          nextPositions.set(record.id, position);
          nextCount++;
        }
        await viewer.dataSources.add(next);
        if (destroyed || generation !== owner || signal?.aborted) {
          remove(next);
          return false;
        }
        remove(source);
        source = next;
        entityRecords = nextEntityRecords;
        entityIds = nextEntityIds;
        byRecord = nextByRecord;
        positions = nextPositions;
        count = nextCount;
        if (selected && !byRecord.has(selected)) selected = null;
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
    pickRecord(picked) {
      const entity = picked?.id;
      return source && entity && typeof entity === 'object'
        ? entityRecords.get(entity) || null
        : null;
    },
    getFocusSphere(id) {
      const position = positions.get(id);
      return position ? new C.BoundingSphere(position, 2_500) : null;
    },
    clear() {
      ++generation;
      remove(source);
      source = null;
      entityRecords = new WeakMap();
      entityIds.clear();
      byRecord.clear();
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
        records: count,
        dataSources: Number(!!source),
        entities: source?.entities.values.length || 0,
        selectedId: selected,
        timerActive: false,
      };
    },
  };
}
