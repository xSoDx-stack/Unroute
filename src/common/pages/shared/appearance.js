import { APPEARANCE_RESET_KEY, withAppearanceWriteLock } from '../../core/appearance-lock.js';

export const APPEARANCE_KEY = 'ui-appearance';

// Both Chrome callback APIs (including runtime.lastError) and Promise APIs.
function storageCall(api, method, argument) {
  return new Promise((resolve, reject) => {
    const callback = value => {
      const error = api?.runtime?.lastError;
      if (error) reject(new Error(error.message || 'Storage unavailable'));
      else resolve(value);
    };
    try {
      const local = api?.storage?.local;
      if (!local?.[method]) throw new Error('Storage unavailable');
      const result = local[method](argument, callback);
      if (result?.then) result.then(resolve, reject);
    } catch (error) { reject(error); }
  });
}

function readCachedAppearance(cache) {
  try {
    const raw = cache?.getItem?.(APPEARANCE_KEY);
    return raw ? normalizeAppearance(JSON.parse(raw)) : null;
  } catch { return null; }
}

function writeCachedAppearance(cache, value) {
  try {
    if (!value) cache?.removeItem?.(APPEARANCE_KEY);
    else cache?.setItem?.(APPEARANCE_KEY, JSON.stringify(normalizeAppearance(value)));
  } catch { /* Synchronous FOUC cache is best-effort; chrome.storage.local is authoritative. */ }
}

export function createAppearanceController({ chrome: api = globalThis.chrome, root = globalThis.document?.documentElement,
  media = globalThis.matchMedia?.('(prefers-color-scheme: dark)'), debounceMs = 120,
  cache = root?.ownerDocument?.defaultView?.localStorage } = {}) {
  const syncCache = api?.storage?.local ? cache : null;
  let appearance = readCachedAppearance(syncCache) || normalizeAppearance();
  let status = 'loading', error = '', errorKind = '';
  let pending = {}, timer, running, activeSnapshot, eventRevision = 0, resetRevision = 0, cleaningReset = false;
  let resetGeneration, destroyed = false;
  const generationOf = value => typeof value === 'string' ? value : undefined;
  const listeners = new Set();
  const getState = () => ({ appearance: { ...appearance }, status, error, errorKind });
  function publish() {
    if (destroyed) return;
    const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && Boolean(media?.matches));
    if (root) {
      root.dataset.theme = dark ? 'dark' : 'light';
      root.dataset.appearanceTheme = appearance.theme;
      root.dataset.accent = appearance.accent;
      root.style.setProperty('color-scheme', dark ? 'dark' : 'light');
      root.style.setProperty('--custom-swatch', appearance.customColor);
      for (const [key, value] of Object.entries(getPalette(appearance, Boolean(media?.matches)))) root.style.setProperty('--' + key, value);
    }
    for (const listener of listeners) listener(getState());
  }
  function fail(reason, kind) {
    status = 'error'; error = reason instanceof Error ? reason.message : String(reason); errorKind = kind; publish();
  }
  function invalidatePending(generation) {
    resetGeneration = generation; resetRevision++;
    pending = {}; clearTimeout(timer); appearance = normalizeAppearance();
    writeCachedAppearance(syncCache, null);
    status = activeSnapshot ? 'saving' : 'idle'; error = ''; errorKind = ''; publish();
  }
  const changed = (changes, area) => {
    if (destroyed || area !== 'local') return;
    if (Object.hasOwn(changes, APPEARANCE_RESET_KEY)) {
      const generation = generationOf(changes[APPEARANCE_RESET_KEY].newValue);
      if (generation !== resetGeneration) { eventRevision++; invalidatePending(generation); }
    }
    if (!Object.hasOwn(changes, APPEARANCE_KEY)) return;
    eventRevision++;
    const incoming = normalizeAppearance(changes[APPEARANCE_KEY].newValue);
    // Our own acknowledgement must not roll back edits made while this write was in flight.
    if (changes[APPEARANCE_KEY].newValue !== undefined && activeSnapshot && JSON.stringify(incoming) === JSON.stringify(activeSnapshot)) return;
    if (changes[APPEARANCE_KEY].newValue === undefined) {
      if (cleaningReset) return;
      resetRevision++;
      pending = {}; clearTimeout(timer); appearance = incoming;
      writeCachedAppearance(syncCache, null);
    } else {
      appearance = normalizeAppearance({ ...incoming, ...pending });
      writeCachedAppearance(syncCache, incoming);
    }
    // An external change is not a retry. Keep a failed pending write actionable.
    if (Object.keys(pending).length && errorKind === 'save') { publish(); return; }
    status = Object.keys(pending).length || activeSnapshot ? 'saving' : 'idle'; error = ''; errorKind = ''; publish();
  };
  // Register before reading: a slow initial read must never undo a newer change event.
  try { api?.storage?.onChanged?.addListener(changed); } catch { /* Defaults still work. */ }
  if (media?.addEventListener) media.addEventListener('change', publish);
  else media?.addListener?.(publish);
  publish();
  const initialRevision = eventRevision;
  const ready = storageCall(api, 'get', [APPEARANCE_KEY, APPEARANCE_RESET_KEY]).then(values => {
    if (destroyed) return;
    if (eventRevision === initialRevision) {
      resetGeneration = generationOf(values?.[APPEARANCE_RESET_KEY]);
      const storedAppearance = values?.[APPEARANCE_KEY];
      writeCachedAppearance(syncCache, storedAppearance === undefined ? null : storedAppearance);
      appearance = normalizeAppearance({ ...normalizeAppearance(storedAppearance), ...pending });
    }
    if (status === 'loading') status = Object.keys(pending).length || activeSnapshot ? 'saving' : 'idle';
    publish();
  }).catch(reason => { if (!destroyed) fail(reason, 'load'); });

  async function drain() {
    await ready;
    if (destroyed) return;
    // Read while holding the origin-wide lock: event delivery may lag behind
    // the reset's callback, and the appearance key may never have existed.
    try {
      const record = await storageCall(api, 'get', APPEARANCE_RESET_KEY);
      const generation = generationOf(record?.[APPEARANCE_RESET_KEY]);
      if (generation !== resetGeneration) { invalidatePending(generation); return; }
    } catch (reason) { fail(reason, 'save'); return; }
    while (!destroyed && Object.keys(pending).length) {
      const patch = pending; pending = {};
      const snapshot = normalizeAppearance({ ...appearance, ...patch });
      const resetAtStart = resetRevision;
      activeSnapshot = snapshot;
      try {
        await storageCall(api, 'set', { [APPEARANCE_KEY]: snapshot });
        // Read back the exact key: acknowledgement alone isn't proof of persistence.
        const stored = await storageCall(api, 'get', APPEARANCE_KEY);
        if (resetRevision !== resetAtStart) {
          // clear() cannot cancel a write already accepted by the browser. Remove only
          // that obsolete snapshot, never a newer setting written by another page.
          if (JSON.stringify(stored?.[APPEARANCE_KEY]) === JSON.stringify(snapshot)) {
            cleaningReset = true;
            try {
              await storageCall(api, 'remove', APPEARANCE_KEY);
              const check = await storageCall(api, 'get', APPEARANCE_KEY);
              if (check?.[APPEARANCE_KEY] !== undefined) throw new Error('Appearance reset could not be confirmed');
              writeCachedAppearance(syncCache, null);
            } finally { cleaningReset = false; }
          }
          activeSnapshot = null; status = Object.keys(pending).length ? 'saving' : 'idle'; publish();
          continue;
        }
        if (JSON.stringify(normalizeAppearance(stored?.[APPEARANCE_KEY])) !== JSON.stringify(snapshot)) {
          throw new Error('Appearance changed before saving could be confirmed');
        }
        writeCachedAppearance(syncCache, snapshot);
        appearance = normalizeAppearance({ ...snapshot, ...pending });
        status = Object.keys(pending).length ? 'saving' : 'saved'; error = ''; errorKind = '';
      } catch (reason) {
        // Retain unsaved fields for explicit retry; do not silently loop on quota/errors.
        if (resetRevision === resetAtStart) pending = { ...patch, ...pending };
        activeSnapshot = null; fail(reason, 'save'); return;
      }
      activeSnapshot = null; publish();
    }
  }
  function flush() {
    clearTimeout(timer);
    if (destroyed) return running || Promise.resolve();
    if (!running) running = Promise.resolve(withAppearanceWriteLock(drain)).finally(() => { running = null; });
    return running;
  }
  function update(patch) {
    if (destroyed || !patch || typeof patch !== 'object' || Array.isArray(patch)) return;
    // Only known fields enter storage; invalid input is normalized, never interpolated into CSS.
    const next = normalizeAppearance({ ...appearance, ...patch });
    for (const key of ['theme', 'accent', 'customColor']) if (Object.hasOwn(patch, key)) pending[key] = next[key];
    appearance = next; status = 'saving'; error = ''; errorKind = ''; publish();
    clearTimeout(timer); timer = setTimeout(flush, debounceMs);
  }
  const controller = { ready, getState, update, flush,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      pending = {};
      listeners.clear();
      if (controllers.get(root) === controller) controllers.delete(root);
      try { api?.storage?.onChanged?.removeListener?.(changed); } catch { /* Context may already be gone. */ }
      if (media?.addEventListener) media.removeEventListener?.('change', publish);
      else media?.removeListener?.(publish);
    },
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener); listener(getState()); return () => listeners.delete(listener);
    },
  };
  return controller;
}

const controllers = new WeakMap();
export function initAppearance() {
  const root = globalThis.document?.documentElement;
  if (!root) return null;
  if (!controllers.has(root)) controllers.set(root, createAppearanceController({ root }));
  return controllers.get(root);
}

const DARK = {
  'bg-primary': '#111415', 'bg-surface': '#171a1c', 'bg-surface-hover': '#202527',
  'bg-surface-active': '#2a3033', 'bg-inset': '#0d1011', 'border-color': '#384144',
  'text-primary': '#edf1f2', 'text-secondary': '#bcc5c8', 'text-muted': '#a0adb1',
  'modal-backdrop': '#000000b3',
  success: '#7bdcc2', 'success-bg': '#123530', 'success-border': '#346d60',
  warning: '#f2c27b', 'warning-bg': '#392d20', 'warning-border': '#826339',
  danger: '#f3a4b9', 'danger-bg': '#3c2334', 'danger-border': '#85506a', 'on-danger': '#26111d',
};
const LIGHT = {
  'bg-primary': '#fafbfd', 'bg-surface': '#ffffff', 'bg-surface-hover': '#f0f3f5',
  'bg-surface-active': '#e5eaed', 'bg-inset': '#f0f3f5', 'border-color': '#cbd3d8',
  'text-primary': '#20272b', 'text-secondary': '#48565e', 'text-muted': '#56656e',
  'modal-backdrop': '#11141580',
  success: '#1c6c55', 'success-bg': '#e4f4ed', 'success-border': '#93c8b4',
  warning: '#805415', 'warning-bg': '#fff2db', 'warning-border': '#cfb57e',
  danger: '#a02e50', 'danger-bg': '#fce9f0', 'danger-border': '#d9a2b5', 'on-danger': '#ffffff',
};
function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function mix(a, b, amount) {
  const target = rgb(b);
  return '#' + rgb(a).map((v, i) => Math.round(v + (target[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}
function luminance(hex) {
  return rgb(hex).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function readable(color, backgrounds, ratio, dark) {
  const target = dark ? '#ffffff' : '#000000';
  for (let i = 0; i <= 100; i++) {
    const candidate = mix(color, target, i / 100);
    if (backgrounds.every(bg => contrast(candidate, bg) >= ratio)) return candidate;
  }
  return target;
}

// Pure, deterministic palette; custom inputs never become CSS syntax.
export function getPalette(value, systemDark = false) {
  const appearance = normalizeAppearance(value);
  const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && systemDark);
  const palette = { ...(dark ? DARK : LIGHT) };
  const accent = appearance.accent === 'custom' ? appearance.customColor : ACCENTS[appearance.accent];
  const onAccent = contrast('#111415', accent) >= 4.5 ? '#111415'
    : contrast('#ffffff', accent) >= 4.5 ? '#ffffff' : '#000000';
  const hoverCandidate = mix(accent, onAccent === '#ffffff' ? '#000000' : '#ffffff', .1);
  const hover = contrast(onAccent, hoverCandidate) >= 4.5 ? hoverCandidate : accent;
  const soft = mix(palette['bg-surface'], accent, dark ? .10 : .07);
  const backgrounds = [palette['bg-primary'], palette['bg-surface'], palette['bg-inset'], palette['bg-surface-hover'], palette['bg-surface-active'], soft];
  const text = readable(accent, backgrounds, 4.5, dark);
  const focus = readable(accent, backgrounds, 3, dark);
  return { ...palette,
    'brand-mint': '#78c6b0', 'brand-cyan': '#78c6b0', 'brand-violet': '#78c6b0',
    'brand-gradient': '#78c6b0', 'accent-primary': accent, 'accent-hover': hover,
    'on-accent': onAccent, 'accent-soft': soft, 'accent-text': text,
    'accent-border': focus, 'border-focus': focus, 'focus-ring': focus, 'accent-gradient': accent,
  };
}
export const ACCENTS = Object.freeze({ mint: '#78c6b0', blue: '#82b3dd', sage: '#a3bc9e' });
export const DEFAULT_APPEARANCE = Object.freeze({ theme: 'system', accent: 'mint', customColor: ACCENTS.mint });

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[a-f0-9]{6}$/.test(hex)) return hex;
  if (/^#[a-f0-9]{3}$/.test(hex)) return '#' + [...hex.slice(1)].map(c => c + c).join('');
  return null;
}

export function normalizeAppearance(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    theme: ['system', 'light', 'dark'].includes(input.theme) ? input.theme : 'system',
    accent: ['mint', 'blue', 'sage', 'custom'].includes(input.accent) ? input.accent : 'mint',
    customColor: normalizeHex(input.customColor) || ACCENTS.mint,
  };
}
