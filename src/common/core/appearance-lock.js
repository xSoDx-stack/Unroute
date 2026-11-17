// All extension pages and its service worker share an origin. Coordinate the
// small appearance write/readback transaction with the full-settings reset.
export const APPEARANCE_RESET_KEY = 'ui-appearance-reset';

export function withAppearanceWriteLock(operation, locks = globalThis.navigator?.locks) {
  return locks?.request ? locks.request('unroute-ui-appearance', operation) : operation();
}
