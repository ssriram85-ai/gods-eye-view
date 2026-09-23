import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  createCycloneSnapshotValidator,
  CYCLONE_RESPONSE_LIMIT,
} from '../cyclones/source.js';

/** JTWC snapshot rules: io/wp/sh storm ids and only JTWC product links. */
export const JTWC_CYCLONE_RULES = Object.freeze({
  idPattern: /^(?:io|wp|sh)\d{6}$/,
  origin: 'https://www.metoc.navy.mil',
  advisoryLink: (url) =>
    !url.search &&
    /^\/jtwc\/products\/(?:io|wp|sh)\d{4}web\.txt$/.test(url.pathname),
  outlookLink: (url) =>
    !url.search &&
    (/^\/jtwc\/products\/ab(?:io|pw)web\.txt$/.test(url.pathname) ||
      url.pathname === '/jtwc/jtwc.html'),
});

export const validateJtwcSnapshot =
  createCycloneSnapshotValidator(JTWC_CYCLONE_RULES);

/** Lazy same-origin acquisition of /api/jtwc; the source owns only its deadline and cancellation. */
export function createJtwcSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('JTWC request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/jtwc', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`JTWC HTTP ${response.status}`);
        }
        const result = await readResponseJsonCapped(
          response,
          CYCLONE_RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return validateJtwcSnapshot(result);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
