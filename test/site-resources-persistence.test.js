import assert from 'node:assert/strict';
import { SiteResources } from '../src/common/core/site-resources.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';

const key = 'site-resource-tabs';

const newTracker = () => {
  const tracker = new SiteResources();
  tracker.schedule = () => {};
  return tracker;
};

describe('Site resource session persistence', () => {
  let original;
  let session;
  let writes;
  let tabs;
  let tracker;

  beforeEach(() => {
    original = { chrome: globalThis.chrome, getMods: pacKitchen.getPacMods, apply: settingsCoordinator.apply };
    session = {};
    writes = [];
    tabs = [{ id: 1, url: 'https://www.example.com/' }];
    globalThis.chrome = {
      runtime: {},
      tabs: {
        query: (_, callback) => callback(tabs),
        get: (id, callback) => callback(tabs.find(tab => tab.id === id)),
      },
      storage: { session: {
        get: (name, callback) => callback(structuredClone({ [name]: session[name] })),
        set: (data, callback) => {
          writes.push(structuredClone(data));
          Object.assign(session, structuredClone(data));
          callback();
        },
        remove: (name, callback) => { delete session[name]; callback(); },
      } },
    };
    pacKitchen.getPacMods = async () => ({ ifMindExceptions: true });
    tracker = newTracker();
  });

  afterEach(() => {
    globalThis.chrome = original.chrome;
    pacKitchen.getPacMods = original.getMods;
    settingsCoordinator.apply = original.apply;
  });

  const request = (tracker, host, tabId = 1) =>
    tracker.observe({ tabId, url: `https://${host}/asset`, type: 'image' });

  it('skips session writes for repeated unchanged batches but still persists new hosts under the legacy key', async () => {
    for (let i = 0; i < 300; i++) await request(tracker, `cdn${i}.example.net`);
    await tracker.flush();
    await tracker.flush();
    await tracker.reconsider();
    await tracker.flush();
    assert.equal(writes.length, 1);
    assert.equal(session[key][1].hosts.length, 300);

    tabs.push({ id: 2, url: 'https://example.org/' });
    await request(tracker, 'images.cdn.test', 2);
    await tracker.flush();
    assert.equal(writes.length, 2);
    assert.deepEqual(session[key][2], {
      root: 'example.org', hosts: ['images.cdn.test'], needsReload: false,
    });
  });

  it('does not let an unacknowledged write recreate a snapshot after reset', async () => {
    await request(tracker, 'images.cdn.test');
    const storage = chrome.storage.session;
    const set = storage.set;
    let finishWrite;
    let notifyWriteStarted;
    const writeStarted = new Promise(resolve => { notifyWriteStarted = resolve; });
    storage.set = (data, callback) => {
      finishWrite = () => set(data, callback);
      notifyWriteStarted();
    };
    const persisting = tracker.persist();
    await writeStarted;
    const clearing = tracker.clear();
    await new Promise(resolve => setImmediate(resolve));
    finishWrite();
    await Promise.all([persisting, clearing]);
    assert.equal(Object.hasOwn(session, key), false);

    storage.set = set;
    await request(tracker, 'images.cdn.test');
    await tracker.flush();
    assert.deepEqual(session[key][1].hosts, ['images.cdn.test']);
  });

  it('retries a snapshot after a failed storage acknowledgement', async () => {
    await request(tracker, 'images.cdn.test');
    const storage = chrome.storage.session;
    const set = storage.set;
    storage.set = (_, callback) => {
      chrome.runtime.lastError = { message: 'Session write failed' };
      try { callback(); } finally { delete chrome.runtime.lastError; }
    };
    await assert.rejects(tracker.persist(), /Session write failed/);
    assert.equal(Object.hasOwn(session, key), false);

    storage.set = set;
    await tracker.persist();
    assert.deepEqual(session[key][1].hosts, ['images.cdn.test']);
  });

  it('recovers pending apply from the legacy snapshot and persists a flag-only change', async () => {
    session[key] = { needsApply: true, 1: { root: 'example.com', hosts: ['images.cdn.test'], needsReload: true } };
    let applyCalls = 0;
    let pending = true;
    settingsCoordinator.apply = async () => ({ pending, error: `Apply attempt ${++applyCalls}` });
    await tracker.init();
    await assert.rejects(tracker.flush(), /Apply attempt 1/);
    await tracker.persist();
    assert.equal(session[key].needsApply, true);
    assert.equal(session[key][1].needsReload, true);

    pending = false;
    await tracker.flush();
    assert.equal(applyCalls, 2);
    assert.deepEqual(session[key], {
      needsApply: false, 1: { root: 'example.com', hosts: ['images.cdn.test'], needsReload: true },
    });
  });

  it('prunes closed, navigated and private tabs from a legacy snapshot', async () => {
    tabs.push({ id: 3, url: 'https://changed.test/' }, { id: 4, url: 'https://private.test/', incognito: true });
    session[key] = { needsApply: false,
      1: { root: 'example.com', hosts: ['keep.test'], needsReload: false },
      2: { root: 'closed.test', hosts: ['closed-cdn.test'], needsReload: false },
      3: { root: 'old.test', hosts: ['stale-cdn.test'], needsReload: true },
      4: { root: 'private.test', hosts: ['private-cdn.test'], needsReload: true },
    };
    await tracker.init();
    await tracker.flush();
    assert.deepEqual(session[key], { needsApply: false,
      1: { root: 'example.com', hosts: ['keep.test'], needsReload: false },
      3: { root: 'changed.test', hosts: [], needsReload: false },
    });
    await request(tracker, 'private-cdn.test', 4);
    await tracker.flush();
    assert.equal(Object.hasOwn(session[key], 4), false);
  });
});
