import assert from 'node:assert/strict';
import { logger } from '../src/common/core/logger.js';
import { errorHandlers } from '../src/common/core/error-handlers.js';
import { ipToHost } from '../src/common/core/ip-to-host.js';
import { storage } from '../src/common/core/storage.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const ip = index => `198.18.${Math.floor(index / 256)}.${index % 256}`;

describe('Diagnostic storage', () => {
  let originalGet, originalSet, originalChrome, listenersRegistered;
  beforeEach(async () => {
    originalGet = storage.get;
    originalSet = storage.set;
    originalChrome = globalThis.chrome;
    listenersRegistered = errorHandlers._listenersRegistered;
    globalThis.chrome = { runtime: {} };
    storage.get = async (_key, fallback) => fallback;
    storage.set = async () => {};
    logger.resetRuntimeState();
    errorHandlers.resetRuntimeState();
    ipToHost.reset();
    await logger.savePromise;
  });

  afterEach(async () => {
    logger.resetRuntimeState();
    errorHandlers.resetRuntimeState();
    ipToHost.reset();
    await logger.savePromise;
    storage.get = originalGet;
    storage.set = originalSet;
    globalThis.chrome = originalChrome;
    errorHandlers._listenersRegistered = listenersRegistered;
  });

  it('restores once and saves both early and restored entries', async () => {
    const read = deferred();
    let reads = 0, saved;
    storage.get = () => { reads++; return read.promise; };
    storage.set = async (_key, value) => { saved = value; };

    const init = logger.init();
    const other = logger.init();
    logger.error('system', 'Early');
    read.resolve([{ title: 'Previous', level: null, category: null }]);
    await Promise.all([init, other, logger.savePromise]);

    assert.equal(reads, 1);
    assert.deepEqual(logger.getLogs().map(entry => entry.title), ['Early', 'Previous']);
    assert.deepEqual(saved.map(entry => entry.title), ['Early', 'Previous']);
    assert.match(logger.exportText(), /Previous/);
  });

  it('keeps new diagnostic categories and exports exactly the matching severity and search', async () => {
    await logger.init();
    logger.error('backup', 'Import failed', 'Could not restore settings');
    logger.warn('backup', 'Import warning', 'Review settings');
    logger.error('rules', 'Import rules failed', 'Could not save rules');
    logger.error('settings', 'Apply failed');

    const stats = logger.getStats();
    assert.deepEqual([stats.backup, stats.rules, stats.settings], [2, 1, 1]);
    const report = logger.exportReport({ category: 'backup', level: 'error', search: 'restore' });
    assert.equal(report.count, 1);
    assert.match(report.text, /Import failed/);
    assert.doesNotMatch(report.text, /Import warning|Import rules failed|Apply failed/);
    assert.equal(logger.exportReport({ category: 'backup', level: 'info' }).count, 0);
  });

  it('does not restore pre-clear history from an in-flight read', async () => {
    const read = deferred();
    storage.get = () => read.promise;
    const init = logger.init();
    await tick();
    await logger.clear();
    read.resolve([{ title: 'Old' }]);
    await init;
    assert.deepEqual(logger.getLogs(), []);
  });

  it('orders a save made during a clear after the empty write', async () => {
    await logger.init();
    const emptyWrite = deferred();
    const writes = [];
    let saved;
    storage.set = async (_key, value) => {
      writes.push(value.map(entry => entry.title));
      if (!value.length) await emptyWrite.promise;
      saved = value;
    };
    const clear = logger.clear();
    await tick();
    logger.error('system', 'After clear');
    await tick();
    try {
      assert.deepEqual(writes, [[]]);
    } finally {
      emptyWrite.resolve();
      await Promise.all([clear, logger.savePromise]);
    }
    assert.deepEqual(saved.map(entry => entry.title), ['After clear']);
  });

  it('takes independent snapshots of the repeat counter without sharing writable details', async () => {
    await logger.init();
    const writes = [];
    storage.set = async (_key, value) => { writes.push(value); };
    const details = { nested: { status: 'original' } };
    const entry = logger.error('system', 'Repeated', '', details);
    details.nested.status = 'caller mutation';
    Reflect.set(entry.details.nested, 'status', 'return value mutation');
    Reflect.set(logger.getLogs()[0], 'title', 'query result mutation');
    logger.error('system', 'Repeated');
    await logger.queueSave();
    assert.equal(writes[0][0].count, undefined);
    assert.equal(writes[0][0].details.nested.status, 'original');
    assert.equal(writes[1][0].title, 'Repeated');
    assert.equal(writes[1][0].count, 2);
  });

  it('restores notification settings before serializing concurrent changes', async () => {
    const read = deferred();
    const firstWrite = deferred();
    const writes = [];
    storage.get = () => read.promise;
    storage.set = async (_key, value) => {
      writes.push(value);
      if (writes.length === 1) await firstWrite.promise;
    };
    const first = errorHandlers.setNotificationOption('ext-error', false);
    const second = errorHandlers.setNotificationOption('no-control', false);
    try {
      await tick();
      assert.deepEqual(writes, []);
      read.resolve({ notificationsEnabled: { 'pac-error': false }, noControlActive: true });
      await tick();
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0], {
        notificationsEnabled: { 'pac-error': false, 'ext-error': false, 'no-control': true },
        noControlActive: true,
      });
    } finally {
      read.resolve(null);
      firstWrite.resolve();
      await Promise.all([first, second]);
    }
    assert.equal(writes[1].notificationsEnabled['no-control'], false);
    assert.equal(writes[1].notificationsEnabled['pac-error'], false);
  });

  it('bounds a bulk IP addition and evicts only the oldest dynamic addresses', async () => {
    let saved;
    storage.set = async (_key, value) => { saved = value; };
    ipToHost.addHost('bulk.test', Array.from({ length: 510 }, (_, index) => ip(index)));
    ipToHost.addHost('latest.test', [ip(510)]);
    await ipToHost.persistData();
    assert.equal(Object.keys(saved).length, 500);
    assert.equal(ipToHost.get(ip(0)), null);
    assert.equal(ipToHost.get(ip(509)), 'bulk.test');
    assert.equal(ipToHost.get(ip(510)), 'latest.test');
    assert.equal(ipToHost.get('127.0.0.1'), 'localhost');
  });

  it('bounds restored IP data without changing its object storage format', async () => {
    let saved;
    storage.get = async () => Object.fromEntries(Array.from({ length: 510 }, (_, index) => [ip(index), 'saved.test']));
    storage.set = async (_key, value) => { saved = value; };
    await ipToHost.init();
    await ipToHost.persistData();
    assert.equal(Object.keys(saved).length, 500);
    assert.equal(ipToHost.get(ip(0)), null);
    assert.equal(saved[ip(509)], 'saved.test');
    assert.equal(saved['127.0.0.1'], 'localhost');
  });
});
