'use strict';

import { expect } from 'chai';
import { pacKitchen, updatePacMods } from '../src/common/core/pac-kitchen.js';
import { storage } from '../src/common/core/storage.js';

let mockStorage = {};
let storageWriteShouldFail = false;

describe('PAC Kitchen: Concurrency, Persist-First & Reset (Tasks 2, 3, 4)', () => {
  afterEach(() => { pacKitchen.endReset(); });
  beforeEach(async () => {
    mockStorage = {};
    storageWriteShouldFail = false;

    globalThis.chrome = {
      runtime: {
        get lastError() {
          return storageWriteShouldFail ? { message: 'Simulated Disk I/O Write Failure' } : null;
        },
      },
      storage: {
        local: {
          get: (key, cb) => {
            if (typeof key === 'string') {
              cb({ [key]: mockStorage[key] });
            } else {
              cb(Object.assign({}, mockStorage));
            }
          },
          set: (items, cb) => {
            if (!storageWriteShouldFail) {
              Object.assign(mockStorage, items);
            }
            if (cb) cb();
          },
          remove: (keys, cb) => {
            const kArr = Array.isArray(keys) ? keys : [keys];
            kArr.forEach((k) => delete mockStorage[k]);
            if (cb) cb();
          },
          clear: (cb) => {
            mockStorage = {};
            if (cb) cb();
          },
        },
      },
    };

    pacKitchen.invalidateCache();
    await storage.clear();
  });

  it('Task 2: Concurrent mutations via updatePacMods must serialize without losing updates', async () => {
    // Initial state
    await pacKitchen.savePacMods({
      exceptions: { 'initial.example': true },
      ifUseSecureProxiesOnly: false,
      ifProxyOrDie: true,
    });

    // Run two concurrent updates that modify DIFFERENT fields of pacMods
    const op1 = updatePacMods(async (current) => {
      // simulate slight async delay
      await new Promise((r) => setTimeout(r, 10));
      const exceptions = Object.assign({}, current.exceptions || {}, { 'site1.example': true });
      return Object.assign({}, current, { exceptions });
    });

    const op2 = updatePacMods(async (current) => {
      await new Promise((r) => setTimeout(r, 5));
      return Object.assign({}, current, { ifUseSecureProxiesOnly: true });
    });

    const [res1, res2] = await Promise.all([op1, op2]);

    // Both operations completed
    expect(res1).to.exist;
    expect(res2).to.exist;

    // Verify final state has BOTH changes (neither was lost due to race condition)
    const finalMods = await pacKitchen.getPacMods();
    expect(finalMods.exceptions['site1.example']).to.equal(true);
    expect(finalMods.exceptions['initial.example']).to.equal(true);
    expect(finalMods.ifUseSecureProxiesOnly).to.equal(true);
  });

  it('hydrates a large snapshot once for concurrent raw and parsed reads after wake-up', async () => {
    const exceptions = Object.fromEntries(Array.from({ length: 33000 }, (_, index) => [`site-${index}.test`, true]));
    await pacKitchen.savePacMods({ exceptions });
    pacKitchen.invalidateCache();
    const originalGet = storage.get;
    let reads = 0;
    storage.get = async (...args) => {
      reads++;
      await new Promise(resolve => setTimeout(resolve, 0));
      return structuredClone(await originalGet.apply(storage, args));
    };
    try {
      const snapshots = await Promise.all(Array.from({ length: 20 }, () =>
        Promise.all([pacKitchen.getRawPacMods(), pacKitchen.getPacMods()])));
      expect(reads).to.equal(1);
      const [raw, parsed] = snapshots[0];
      for (const [nextRaw, nextParsed] of snapshots) {
        expect(nextRaw).to.equal(raw);
        expect(nextParsed).to.equal(parsed);
      }
      expect(parsed.exceptions['site-32999.test']).to.equal(true);
      expect(parsed.ruleMeta).to.equal(raw.ruleMeta);
    } finally { storage.get = originalGet; }
  });

  it('automatically upgrades legacy rules atomically without changing their revision', async () => {
    const legacy = { _schemaVersion: 1, exceptions: { 'legacy.test': true }, whitelist: ['legacy.test'],
      customProxyStringRaw: 'HTTPS user:pass@proxy.test:443' };
    mockStorage['pac-kitchen-mods'] = legacy;
    expect((await pacKitchen.getPacMods()).exceptions).to.deep.equal(legacy.exceptions);
    // The initial cold read is itself the persist-first migration barrier.
    await updatePacMods(current => current, { copyOnWrite: true });
    expect(mockStorage['pac-kitchen-mods']._schemaVersion).to.equal(3);
    expect(mockStorage['pac-kitchen-mods']._revision).to.equal(0);
    expect(mockStorage['pac-kitchen-mods']._rulesRevision).to.equal(0);
    await updatePacMods(current => ({ ...current, exceptions: { ...current.exceptions, 'next.test': false } }), { copyOnWrite: true });
    expect(mockStorage['pac-kitchen-mods']._schemaVersion).to.equal(3);
    expect(mockStorage['pac-kitchen-mods']._ruleData).to.be.a('string');
    expect(mockStorage['pac-kitchen-mods']).not.to.have.property('exceptions');
    const committed = await pacKitchen.getRawPacMods();
    pacKitchen.invalidateCache();
    expect(await pacKitchen.getRawPacMods()).to.deep.equal(committed);
    expect((await pacKitchen.getPacMods()).exceptions).to.include({ 'legacy.test': true, 'next.test': false });
  });

  it('persists the five-entry history limit when loading an existing compact snapshot', async () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ id: `r${12 - i}`, revision: 12 - i, changes: [] }));
    mockStorage['pac-kitchen-mods'] = { _schemaVersion: 2, _revision: 12,
      _ruleData: JSON.stringify([[], [], [], [], [], history]) };
    expect((await pacKitchen.getRawPacMods()).ruleHistory).to.have.length(5);
    await updatePacMods(current => current, { copyOnWrite: true });
    const persisted = mockStorage['pac-kitchen-mods'];
    expect(JSON.parse(persisted._ruleData)[5]).to.have.length(5);
    expect(persisted._revision).to.equal(12);
  });

  it('does not overwrite a concurrent edit with the legacy snapshot during upgrade', async () => {
    mockStorage['pac-kitchen-mods'] = { exceptions: { 'legacy.test': true }, customProxyStringRaw: 'HTTPS old.test:443' };
    await updatePacMods(current => ({ ...current, customProxyStringRaw: 'HTTPS new.test:443',
      exceptions: { ...current.exceptions, 'new.test': false },
    }), { copyOnWrite: true });
    await updatePacMods(current => current, { copyOnWrite: true });
    const committed = await pacKitchen.getRawPacMods();
    expect(committed.customProxyStringRaw).to.equal('HTTPS new.test:443');
    expect(committed.exceptions).to.include({ 'legacy.test': true, 'new.test': false });
    expect(committed._revision).to.equal(1);
    pacKitchen.invalidateCache();
    expect(await pacKitchen.getRawPacMods()).to.deep.equal(committed);
  });

  it('retains legacy data when the automatic upgrade fails and retries after restart', async () => {
    const legacy = { exceptions: { 'legacy.test': true }, customProxyStringRaw: 'HTTPS proxy.test:443' };
    mockStorage['pac-kitchen-mods'] = legacy;
    storageWriteShouldFail = true;
    // Fail writes only, not the initial read.
    const originalGet = storage.get;
    storage.get = async () => legacy;
    try {
      const failure = await pacKitchen.getPacMods().catch(error => error);
      expect(failure).to.be.an('error');
      expect(failure.message).to.include('Simulated Disk I/O Write Failure');
      expect(pacKitchen.getCachedMods()).to.equal(null);
      expect(mockStorage['pac-kitchen-mods']).to.equal(legacy);
      storageWriteShouldFail = false;
      pacKitchen.invalidateCache();
      await pacKitchen.getPacMods();
      await updatePacMods(current => current, { copyOnWrite: true });
      expect(mockStorage['pac-kitchen-mods']._ruleData).to.be.a('string');
      expect(mockStorage['pac-kitchen-mods'].proxyProfiles[0].id).to.equal((await pacKitchen.getRawPacMods()).proxyProfiles[0].id);
    } finally { storage.get = originalGet; }
  });

  it('drains a running automatic upgrade before reset clears storage', async () => {
    mockStorage['pac-kitchen-mods'] = { exceptions: { 'legacy.test': true } };
    const originalSet = chrome.storage.local.set;
    let release;
    let started;
    const writing = new Promise(resolve => { started = resolve; });
    chrome.storage.local.set = (items, callback) => {
      release = () => originalSet(items, callback);
      started();
    };
    try {
      const reading = pacKitchen.getPacMods();
      await writing;
      let drained = false;
      const reset = pacKitchen.beginReset().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).to.equal(false);
      release();
      await Promise.all([reading, reset]);
      await storage.clear();
      pacKitchen.invalidateCache();
      pacKitchen.endReset();
      expect((await pacKitchen.getPacMods()).exceptions).to.deep.equal({});
      expect(mockStorage).not.to.have.property('pac-kitchen-mods');
    } finally { chrome.storage.local.set = originalSet; pacKitchen.endReset(); }
  });

  it('leaves malformed legacy rule data readable instead of writing an unloadable snapshot', async () => {
    for (const legacy of [{ exceptions: { 'bad.test': 'true' } }, { whitelist: [''] }, { exceptions: { '': true } }]) {
      mockStorage['pac-kitchen-mods'] = legacy;
      pacKitchen.invalidateCache();
      await pacKitchen.getPacMods();
      await updatePacMods(current => current, { copyOnWrite: true });
      expect(mockStorage['pac-kitchen-mods']).to.equal(legacy);
      pacKitchen.invalidateCache();
      await pacKitchen.getPacMods();
      await updatePacMods(current => current, { copyOnWrite: true });
      expect(mockStorage['pac-kitchen-mods']).to.equal(legacy);
    }
  });

  it('discards empty legacy history domains so migration and later edits can save', async () => {
    mockStorage['pac-kitchen-mods'] = { _schemaVersion: 1, _revision: 1,
      exceptions: { 'good.test': true }, ruleHistory: [{ id: 'r1', revision: 1,
        changes: [{ kind: 'exception', domain: '', before: null, after: true }] }] };
    await pacKitchen.getPacMods();
    await updatePacMods(current => current, { copyOnWrite: true });
    expect(mockStorage['pac-kitchen-mods']._ruleData).to.be.a('string');
    expect((await pacKitchen.getRawPacMods()).ruleHistory[0].changes).to.deep.equal([]);
    await updatePacMods(current => ({ ...current, exceptions: { ...current.exceptions, 'new.test': false } }), { copyOnWrite: true });
    pacKitchen.invalidateCache();
    expect((await pacKitchen.getPacMods()).exceptions).to.include({ 'good.test': true, 'new.test': false });
  });

  it('keeps a corrupt stored snapshot intact when loading or editing fails', async () => {
    const corrupt = { _schemaVersion: 2, _ruleData: '{' };
    mockStorage['pac-kitchen-mods'] = corrupt;
    const results = await Promise.allSettled([pacKitchen.getPacMods(), updatePacMods(current => ({ ...current, exceptions: {} }))]);
    expect(results.every(result => result.status === 'rejected')).to.equal(true);
    expect(mockStorage['pac-kitchen-mods']).to.equal(corrupt);
    expect(pacKitchen.getCachedMods()).to.equal(null);
  });

  it('retries a failed shared cold read without retaining its rejected promise', async () => {
    const originalGet = storage.get;
    let reads = 0;
    storage.get = async (...args) => {
      if (++reads === 1) throw new Error('Temporary read failure');
      return originalGet.apply(storage, args);
    };
    try {
      const failed = await Promise.allSettled([pacKitchen.getPacMods(), pacKitchen.getRawPacMods()]);
      expect(failed.every(result => result.status === 'rejected')).to.equal(true);
      expect(reads).to.equal(1);
      expect((await pacKitchen.getPacMods()).exceptions).to.deep.equal({});
      expect(reads).to.equal(2);
    } finally { storage.get = originalGet; }
  });

  it('discards an in-flight snapshot after invalidation instead of restoring old rules', async () => {
    const originalGet = storage.get;
    let release;
    let reads = 0;
    storage.get = async () => {
      if (++reads === 1) return new Promise(resolve => { release = resolve; });
      return { exceptions: { 'current.test': false }, _revision: 7 };
    };
    try {
      const oldRead = pacKitchen.getPacMods();
      pacKitchen.invalidateCache();
      const currentRead = pacKitchen.getRawPacMods();
      release({ exceptions: { 'obsolete.test': true }, _revision: 3 });
      const [parsed, raw] = await Promise.all([oldRead, currentRead]);
      expect(parsed.exceptions).to.deep.equal({ 'current.test': false });
      expect(raw._revision).to.equal(7);
      expect(await pacKitchen.getRawPacMods()).to.equal(raw);
      expect(reads).to.equal(2);
    } finally { storage.get = originalGet; }
  });

  it('reuses cached rule statistics for preferences and associates counters with their revision', async () => {
    await pacKitchen.savePacMods({ exceptions: { 'initial.test': true }, whitelist: [] });
    const first = await pacKitchen.getSnapshot();
    await updatePacMods(current => ({ ...current, ifProxyOrDie: false }), { preferencesOnly: true });
    const next = await pacKitchen.getSnapshot();
    expect(next.stats).to.equal(first.stats);
    expect(next.revision).to.equal(first.revision + 1);
    // Simulate a revision published between getPacMods() and the snapshot's
    // async continuation. Its counters must still belong to the returned mods.
    const originalGet = pacKitchen.getPacMods;
    pacKitchen.getPacMods = async () => {
      await updatePacMods(current => ({ ...current, exceptions: { 'one.test': false, 'two.test': false } }));
      return first.mods;
    };
    try {
      const snapshot = await pacKitchen.getSnapshot();
      expect(snapshot.stats).to.deep.equal({ includedCount: 1, excludedCount: 0, whitelistCount: 0 });
      expect(snapshot.revision).to.equal(first.revision);
    } finally { pacKitchen.getPacMods = originalGet; }
  });

  it('preserves untouched metadata and history during copy-on-write resource edits', async () => {
    await pacKitchen.savePacMods({ exceptions: { 'initial.test': true }, whitelist: [] });
    const before = await pacKitchen.getRawPacMods();
    await updatePacMods(current => ({ ...current,
      exceptions: { ...current.exceptions, 'cdn.test': true, 'invalid host': true },
    }), { source: 'auto', copyOnWrite: true });
    const after = await pacKitchen.getRawPacMods();
    expect(after.ruleMeta['exception:initial.test']).to.equal(before.ruleMeta['exception:initial.test']);
    expect(after.ruleHistory[1]).to.equal(before.ruleHistory[0]);
    expect(after.exceptions).to.include({ 'initial.test': true, 'cdn.test': true });
    expect(after.exceptions).not.to.have.property('invalid host');
    expect(before.exceptions).not.to.have.property('cdn.test');
  });

  it('skips storage and revision changes when a copy-on-write batch is superseded', async () => {
    await pacKitchen.savePacMods({ exceptions: { 'initial.test': true } });
    const before = await pacKitchen.getRawPacMods();
    const stored = mockStorage['pac-kitchen-mods'];
    const result = await updatePacMods(current => current, { source: 'auto', copyOnWrite: true });
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
    expect(mockStorage['pac-kitchen-mods']).to.equal(stored);
    expect(result.revision).to.equal(before._revision);
  });

  it('retains the committed snapshot when a copy-on-write rule save fails', async () => {
    await pacKitchen.savePacMods({ exceptions: { 'initial.test': true } });
    const before = await pacKitchen.getRawPacMods();
    storageWriteShouldFail = true;
    let error;
    try {
      await updatePacMods(current => ({ ...current, exceptions: { ...current.exceptions, 'cdn.test': true } }),
        { source: 'auto', copyOnWrite: true });
    } catch (caught) { error = caught; }
    expect(error).to.be.an('error');
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
    expect(before.exceptions).not.to.have.property('cdn.test');
  });

  it('rejects late and in-flight mutations during reset before clearing persistent state', async () => {
    let started;
    let release;
    const ready = new Promise(resolve => { started = resolve; });
    const mutation = updatePacMods(async current => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { ...current, exceptions: { 'stale.test': true } };
    }).catch(error => error);
    await ready;
    const drain = pacKitchen.beginReset();
    const late = updatePacMods(current => ({ ...current, exceptions: { 'late.test': true } })).catch(error => error);
    release();
    expect(await mutation).to.be.an('error');
    expect(await late).to.be.an('error');
    await drain;
    await storage.clear();
    pacKitchen.invalidateCache();
    pacKitchen.endReset();
    expect((await pacKitchen.getRawPacMods()).exceptions).to.equal(undefined);
    await updatePacMods(current => ({ ...current, exceptions: { 'fresh.test': false } }));
    expect((await pacKitchen.getPacMods()).exceptions).to.deep.equal({ 'fresh.test': false });
  });

  it('Task 3: When storage write fails, savePacMods rejects and RAM cache remains unchanged', async () => {
    // Initial valid state
    await pacKitchen.savePacMods({
      exceptions: { 'saved.example': true },
      ifUseSecureProxiesOnly: false,
    });

    const beforeMods = await pacKitchen.getPacMods();
    expect(beforeMods.exceptions['saved.example']).to.equal(true);

    // Turn on simulated storage failure
    storageWriteShouldFail = true;

    let threw = false;
    try {
      await pacKitchen.savePacMods({
        exceptions: { 'unsaved.example': true },
        ifUseSecureProxiesOnly: true,
      });
    } catch (err) {
      threw = true;
      expect(err.message).to.include('Simulated Disk I/O Write Failure');
    }

    expect(threw).to.be.true;

    // Cache must still hold the previous authoritative state
    const afterMods = await pacKitchen.getPacMods();
    expect(afterMods.exceptions['saved.example']).to.equal(true);
    expect(afterMods.exceptions['unsaved.example']).to.be.undefined;
    expect(afterMods.ifUseSecureProxiesOnly).to.equal(false);
  });

  it('Task 3b: When storage write fails, proxyAuth active in-memory credentials do NOT switch to new unpersisted credentials', async () => {
    // 1. Initially saved valid proxy credentials
    await pacKitchen.savePacMods({
      customProxyStringRaw: 'HTTPS initialUser:initialPass@valid.proxy.com:443',
    });

    const { findCredentials } = await import('../src/common/core/proxy-auth.js');
    expect(findCredentials('valid.proxy.com', 443)).to.deep.equal({
      username: 'initialUser',
      password: 'initialPass',
    });

    // 2. Storage write fails on new update
    storageWriteShouldFail = true;

    let threw = false;
    try {
      await pacKitchen.savePacMods({
        customProxyStringRaw: 'HTTPS newUser:newPass@unwritten.proxy.com:443',
      });
    } catch {
      threw = true;
    }

    expect(threw).to.be.true;

    // 3. Verify in-memory proxyAuth map STILL has initial credentials and did NOT adopt unwritten ones
    expect(findCredentials('valid.proxy.com', 443)).to.deep.equal({
      username: 'initialUser',
      password: 'initialPass',
    });
    expect(findCredentials('unwritten.proxy.com', 443)).to.be.null;
  });

  it('Task 4: RESET_SETTINGS clears storage and RAM cache, returning to default state', async () => {
    // 1. Save custom mods
    await pacKitchen.savePacMods({
      exceptions: { 'custom.example': true, 'direct.example': false },
      ifUseSecureProxiesOnly: true,
      customProxyStringRaw: 'HTTPS custom-proxy.local:8443',
    });

    // 2. Warm RAM cache
    const warmed = await pacKitchen.getPacMods();
    expect(warmed.exceptions['custom.example']).to.equal(true);
    expect(warmed.ifUseSecureProxiesOnly).to.equal(true);

    // 3. Perform RESET
    await storage.clear();
    pacKitchen.invalidateCache();

    // 4. Verify no old values returned from storage or RAM cache
    const freshMods = await pacKitchen.getPacMods();
    expect(freshMods.exceptions).to.deep.equal({});
    expect(freshMods.ifUseSecureProxiesOnly).to.equal(false); // default
    expect(freshMods.customProxyStringRaw).to.equal('');
  });
});
