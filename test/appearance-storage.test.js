import { expect } from 'chai';

function fixture({ delayRead = false, failRead = false, failWrite = false, promiseOnly = false, initial } = {}) {
  let values = initial ? { 'ui-appearance': initial } : {}, initialRead, listener, mediaListener, writes = [], complete;
  let activeWrites = 0, maxWrites = 0;
  const style = new Map();
  const root = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
  const emit = (value, area = 'local') => { if (area === 'local') values = value === undefined ? {} : { ...values, 'ui-appearance': value }; listener?.({ 'ui-appearance': { newValue: value } }, area); };
  const api = { runtime: {}, storage: {
    onChanged: { addListener(fn) { listener = fn; } },
    local: {
      remove(key, cb) { emit(undefined); cb(); },
      get(key, cb) {
        if (delayRead && !initialRead) { initialRead = () => cb({}); return; }
        if (promiseOnly) return failRead ? Promise.reject(Error('read blocked')) : Promise.resolve({ ...values });
        if (failRead) api.runtime.lastError = { message: 'read blocked' };
        cb({ ...values }); delete api.runtime.lastError;
      },
      set(items, cb) {
        writes.push(items); activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
        const done = () => {
          activeWrites--;
          if (failWrite) api.runtime.lastError = { message: 'quota denied' };
          else emit(items['ui-appearance']);
          cb?.(); delete api.runtime.lastError;
        };
        if (promiseOnly) { activeWrites--; return failWrite ? Promise.reject(Error('quota denied')) : Promise.resolve().then(() => emit(items['ui-appearance'])); }
        complete = done;
      },
    },
  } };
  const media = { matches: false, addEventListener(_, fn) { mediaListener = fn; } };
  return { api, root, media, style, emit, writes, resolveRead: () => initialRead(), complete: () => complete(),
    resetSignal(value, notify = true) {
      values = { 'ui-appearance-reset': value };
      if (notify) listener?.({ 'ui-appearance-reset': { newValue: value } }, 'local');
    },
    dark: value => { media.matches = value; mediaListener(); }, maxWrites: () => maxWrites, values: () => values };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('Appearance storage lifecycle', () => {
  it('applies defaults, tracks the system live, and reads callback and promise APIs', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    for (const promiseOnly of [false, true]) {
      const f = fixture({ promiseOnly });
      const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1 });
      await c.ready;
      expect(f.root.dataset.theme).equal('light');
      f.dark(true); expect(f.root.dataset.theme).equal('dark');
      f.emit({ theme: 'light', accent: 'blue', customColor: '#abcdef' });
      f.dark(true); expect(f.root.dataset.theme).equal('light');
      expect(f.style.get('--accent-primary')).equal('#82b3dd');
      f.emit(undefined);
      expect(c.getState().appearance).deep.equal({ theme: 'system', accent: 'mint', customColor: '#78c6b0' });
      expect(f.root.dataset.theme).equal('dark');
    }
  });
  it('ignores stale initial reads after storage events and ignores non-local changes', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture({ delayRead: true });
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media });
    f.emit({ theme: 'dark', accent: 'sage' }); f.resolveRead(); await c.ready;
    expect(c.getState().appearance.theme).equal('dark');
    expect(c.getState().appearance.accent).equal('sage');
    f.emit({ theme: 'light', accent: 'blue' }, 'sync');
    expect(c.getState().appearance.theme).equal('dark');
  });
  it('loads persisted preferences and debounces automatic writes without explicit flush', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const initial = { theme: 'dark', accent: 'custom', customColor: '#abcdef' };
    const f = fixture({ promiseOnly: true, initial });
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 5 });
    await c.ready; expect(c.getState().appearance).deep.equal(initial);
    c.update({ theme: 'light' }); c.update({ accent: 'blue' }); c.update({ theme: 'system' });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.writes).length(1); expect(c.getState().status).equal('saved');
    expect(f.values()['ui-appearance']).deep.equal({ theme: 'system', accent: 'blue', customColor: '#abcdef' });
  });
  it('serializes rapid edits, merges queued fields, preserves custom, and verifies final storage', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture();
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready;
    c.update({ accent: 'custom', customColor: '#123456' });
    const flushing = c.flush(); await tick();
    c.update({ theme: 'dark' }); c.update({ accent: 'blue' });
    f.complete(); await tick(); f.complete(); await flushing;
    expect(f.maxWrites()).equal(1);
    expect(f.writes).length(2);
    expect(f.values()['ui-appearance']).deep.equal({ theme: 'dark', accent: 'blue', customColor: '#123456' });
    expect(c.getState().status).equal('saved');
    expect(Object.keys(f.writes[0])).deep.equal(['ui-appearance']);
  });
  it('cancels pending debounced edits on storage.clear', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture();
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready; c.update({ theme: 'dark' }); f.emit(undefined); await c.flush();
    expect(f.writes).length(0);
    expect(c.getState().appearance.theme).equal('system');
  });
  it('fails soft on unavailable/read-failing storage and exposes honest saving errors with retry', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    for (const promiseOnly of [false, true]) {
      const f = fixture({ failWrite: true, promiseOnly });
      const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
      await c.ready; c.update({ theme: 'dark' });
      const saving = c.flush(); await tick(); if (!promiseOnly) f.complete(); await saving;
      expect(c.getState().status).equal('error');
      expect(c.getState().error).include('quota denied');
    }
    const f = fixture({ failRead: true });
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media });
    await c.ready; expect(c.getState().status).equal('error');
    expect(f.root.dataset.theme).equal('light');
    const unavailable = createAppearanceController({ chrome: {}, root: f.root, media: f.media });
    await unavailable.ready; expect(unavailable.getState().status).equal('error');
  });
  it('does not resurrect an in-flight selection after storage.clear', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture();
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready; c.update({ theme: 'dark' });
    const saving = c.flush(); await tick(); f.emit(undefined); f.complete(); await saving;
    expect(f.values()['ui-appearance']).equal(undefined);
    expect(c.getState().appearance.theme).equal('system');
  });
  it('retries a failed write and persists edits made during a slow initial read', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture({ delayRead: true, failWrite: true });
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    c.update({ theme: 'dark' }); f.resolveRead(); await c.ready;
    const saving = c.flush(); await tick(); f.complete(); await saving;
    expect(c.getState().status).equal('error');
    // Replace the failing callback API with a successful Promise API for retry.
    f.api.storage.local.set = items => { f.emit(items['ui-appearance']); return Promise.resolve(); };
    await c.flush();
    expect(c.getState().status).equal('saved'); expect(f.values()['ui-appearance'].theme).equal('dark');
  });
  it('reapplies an unsaved patch when retrying after a competing page update', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture();
    const originalGet = f.api.storage.local.get;
    let reads = 0;
    f.api.storage.local.get = (key, callback) => {
      if (++reads === 3) f.emit({ theme: 'light', accent: 'blue' });
      return originalGet(key, callback);
    };
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready; c.update({ theme: 'dark' });
    const saving = c.flush(); await tick(); f.complete(); await saving;
    expect(c.getState().status).equal('error');
    const retry = c.flush(); await tick(); f.complete(); await retry;
    expect(f.values()['ui-appearance']).include({ theme: 'dark', accent: 'blue' });
    expect(c.getState().appearance).include({ theme: 'dark', accent: 'blue' });
  });
  it('preserves the retry affordance after a failed write and external changes', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture({ failWrite: true });
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready; c.update({ theme: 'dark' });
    const saving = c.flush(); await tick(); f.complete(); await saving;
    f.emit({ theme: 'light', accent: 'blue' });
    expect(c.getState().status).equal('error');
    expect(c.getState().errorKind).equal('save');
    expect(c.getState().appearance).include({ theme: 'dark', accent: 'blue' });
    f.api.storage.local.set = items => { f.emit(items['ui-appearance']); return Promise.resolve(); };
    await c.flush();
    expect(f.values()['ui-appearance']).include({ theme: 'dark', accent: 'blue' });
    expect(c.getState().status).equal('saved');
  });
  it('invalidates the first unsaved appearance when a reset has no appearance-key event', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture();
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready; c.update({ theme: 'dark' });
    f.resetSignal('reset-one');
    await c.flush();
    expect(f.writes).length(0);
    expect(c.getState().appearance.theme).equal('system');
  });
  it('checks the reset generation before a queued write, without depending on event delivery', async () => {
    const { createAppearanceController } = await import('../src/common/pages/shared/appearance.js');
    const f = fixture();
    const c = createAppearanceController({ chrome: f.api, root: f.root, media: f.media, debounceMs: 1000 });
    await c.ready; c.update({ theme: 'dark' });
    const saving = c.flush();
    f.resetSignal('reset-two', false);
    await saving;
    expect(f.writes).length(0);
    expect(c.getState().appearance.theme).equal('system');
    c.update({ accent: 'blue' });
    const next = c.flush(); await tick(); f.complete(); await next;
    expect(f.values()['ui-appearance']).include({ theme: 'system', accent: 'blue' });
  });
  it('initializes each document only once', async () => {
    const { initAppearance } = await import('../src/common/pages/shared/appearance.js');
    const old = { document: globalThis.document, chrome: globalThis.chrome, matchMedia: globalThis.matchMedia };
    const f = fixture();
    try {
      globalThis.document = { documentElement: f.root }; globalThis.chrome = f.api; globalThis.matchMedia = () => f.media;
      const a = initAppearance(); expect(initAppearance()).equal(a); await a.ready;
    } finally { Object.assign(globalThis, old); }
  });
});
