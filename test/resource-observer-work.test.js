import assert from 'node:assert/strict';
import { SiteResources } from '../src/common/core/site-resources.js';

describe('Site resource observer work', () => {
  let chromeBefore, tracker, listener;
  beforeEach(() => {
    chromeBefore = globalThis.chrome;
    globalThis.chrome = { storage: { onChanged: { addListener(fn) { listener = fn; } } } };
    tracker = new SiteResources();
  });
  afterEach(() => { globalThis.chrome = chromeBefore; });

  it('does not hydrate on listener registration', () => {
    let calls = 0;
    tracker.init = async () => { calls++; };
    tracker.setup();
    assert.equal(calls, 0);
  });

  it('uses versioned routing changes without serializing heavy fields', async () => {
    tracker.init = async () => {};
    let calls = 0;
    tracker.reconsider = async () => { calls++; };
    tracker.setup();
    const heavy = { toJSON() { assert.fail('Unexpected serialization'); } };
    const oldValue = { _revision: 1, _rulesRevision: 2, domainLists: heavy };
    const change = newValue => listener({ 'pac-kitchen-mods': { oldValue, newValue } }, 'local');
    await change({ ...oldValue, _proxyCatalogRevision: 2 });
    assert.equal(calls, 0);
    await change({ ...oldValue, _rulesRevision: 3 });
    await change({ ...oldValue, ifNoMods: true });
    assert.equal(calls, 2);
  });

  it('does not restore an old snapshot after a concurrent reset', async () => {
    let receiveSnapshot;
    globalThis.chrome.runtime = {};
    globalThis.chrome.tabs = { query: (_query, cb) => cb([{ id: 1, url: 'https://site.test/' }]) };
    globalThis.chrome.storage.session = {
      get: (_key, cb) => { receiveSnapshot = cb; },
      remove: (_key, cb) => cb(),
    };
    const observed = tracker.observe({ tabId: 1, type: 'main_frame', url: 'https://site.test/' });
    await tracker.clear();
    receiveSnapshot({ 'site-resource-tabs': { needsApply: true, 1: { root: 'site.test', hosts: ['old.test'] } } });
    await observed;
    assert.equal(tracker.tabs.size, 0);
    assert.equal(tracker.needsApply, false);
    assert.equal(tracker.timer, null);
  });
});
