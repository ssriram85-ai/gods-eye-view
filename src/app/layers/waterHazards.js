import { createWaterHazardsLayer } from '../../layers/water/index.js';
/** Wire the OpenStreetMap water hazard source to the application viewer. */
export function createApplicationWaterHazards(options) {
  return createWaterHazardsLayer(options);
}
