import { createHeatStressLayer } from '../../layers/heat/index.js';
/** Wire Open-Meteo heat stress samples to the application viewer. */
export function createApplicationHeatStress(options) {
  return createHeatStressLayer(options);
}
