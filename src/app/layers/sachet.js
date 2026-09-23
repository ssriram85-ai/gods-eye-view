import { createSachetLayer } from '../../layers/sachet/index.js';
/** Wire NDMA SACHET alert areas to the application viewer. */
export function createApplicationSachet(options) {
  return createSachetLayer(options);
}
