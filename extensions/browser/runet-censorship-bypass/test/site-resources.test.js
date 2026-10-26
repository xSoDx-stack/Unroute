'use strict';

import { expect } from 'chai';
import { SiteResources, resourceHost } from '../src/extension-common/core/site-resources.js';
import { pacKitchen } from '../src/extension-common/core/pac-kitchen.js';
import { pacSync } from '../src/extension-common/core/pac-sync.js';
import { appState } from '../src/extension-common/core/app-state.js';
import { proxyBackend } from '../src/extension-common/core/proxy-backend.js';

describe('Whole-site resource routing', () => {
  let tracker;
  let mods;
  let updates;
  let applies;
  let original;
  let tabs;
  let session;

  beforeEach(() => {
    original = { chrome: globalThis.chrome, get: pacKitchen.getPacMods,
      update: pacKitchen.updatePacMods, apply: pacSync.reapplyCurrentPac, init: appState.ensureInitialized };
    mods = { exceptions: {}, ifMindExceptions: true, filteredCustomsString: 'PROXY localhost:8080' };
    updates = 0;
    applies = 0;
    session = {};
    tabs = [{ id: 1, url: 'https://www.example.com/page', incognito: false }];
    globalThis.chrome = {
      runtime: {},
      tabs: {
        query: (_, cb) => cb(tabs),
        get: (id, cb) => cb(tabs.find((tab) => tab.id === id)),
      },
      storage: { session: {
        get: (_, cb) => cb(session),
        set: (data, cb) => { Object.assign(session, data); cb(); },
        remove: (key, cb) => { delete session[key]; cb(); },
      } },
    };
    pacKitchen.getPacMods = async () => ({ ...mods, ifMindExceptions: mods.ifMindExceptions !== false });
    pacKitchen.updatePacMods = async (fn) => { updates++; mods = await fn(mods); return mods; };
    pacSync.reapplyCurrentPac = async () => { applies++; };
    appState.ensureInitialized = async () => {};
    tracker = new SiteResources();
    tracker.schedule = () => {};
  });

  afterEach(() => {
    globalThis.chrome = original.chrome;
    pacKitchen.getPacMods = original.get;
    pacKitchen.updatePacMods = original.update;
    pacSync.reapplyCurrentPac = original.apply;
    appState.ensureInitialized = original.init;
  });

  async function request(host, type = 'image', tabId = 1) {
    await tracker.observe({ tabId, url: `https://${host}/asset`, type });
  }

  it('collects all request types once, without reading rules or writing per request', async () => {
    for (const type of ['image', 'media', 'xmlhttprequest', 'script', 'sub_frame', 'websocket']) {
      await request('cdn.example.net', type);
    }
    expect((await tracker.summary(1, 'example.com')).hosts).to.deep.equal(['cdn.example.net']);
    expect(updates).to.equal(0);
    await tracker.flush();
    expect(updates).to.equal(0);
    expect(applies).to.equal(0);
  });

  it('explicitly switches the site and every observed resource in both directions', async () => {
    await request('video.example.net', 'media');
    await request('api.example.org', 'xmlhttprequest');
    mods.exceptions = { 'sub.example.com': true, 'api.example.org': true, 'untouched.test': true };
    await tracker.setMode(1, 'example.com', false);
    expect(mods.exceptions).to.include({ 'example.com': false, 'www.example.com': false,
      'sub.example.com': false, 'video.example.net': false, 'api.example.org': false, 'untouched.test': true });
    await tracker.setMode(1, 'example.com', true);
    expect(mods.exceptions['video.example.net']).to.equal(true);
    expect(mods.exceptions['api.example.org']).to.equal(true);
    expect(applies).to.equal(2);
    expect((await tracker.summary(1, 'example.com')).needsReload).to.equal(true);
  });

  it('batches new hosts, inherits legacy root rules, and respects existing overrides', async () => {
    mods = { exceptions: { 'example.com': false, '*.keep.example.net': true }, filteredCustomsString: 'PROXY localhost:8080' };
    for (let i = 0; i < 20; i++) await request(`cdn${i}.example.org`);
    await request('video.keep.example.net');
    await tracker.flush();
    expect(updates).to.equal(1);
    expect(applies).to.equal(1);
    expect(mods.exceptions['cdn19.example.org']).to.equal(false);
    expect(mods.exceptions).not.to.have.property('video.keep.example.net');
    expect(mods.exceptions['*.keep.example.net']).to.equal(true);
    await tracker.flush();
    expect(applies).to.equal(1);
  });

  it('does not oscillate a shared CDN between tabs with opposite rules', async () => {
    tabs.push({ id: 2, url: 'https://other.test/' });
    mods.exceptions = { 'example.com': false, 'other.test': true };
    await request('shared.cdn.test');
    await request('shared.cdn.test', 'media', 2);
    await tracker.flush();
    expect(mods.exceptions['shared.cdn.test']).to.equal(false);
    await tracker.setMode(2, 'other.test', true);
    await request('shared.cdn.test');
    await tracker.flush();
    expect(mods.exceptions['shared.cdn.test']).to.equal(true);
  });

  it('keeps new requests that arrive during PAC application for the next batch', async () => {
    mods.exceptions['example.com'] = true;
    await request('first.cdn.test');
    pacSync.reapplyCurrentPac = async () => { await request('late.cdn.test'); };
    await tracker.flush();
    expect(mods.exceptions).not.to.have.property('late.cdn.test');
    await tracker.flush();
    expect(mods.exceptions['late.cdn.test']).to.equal(true);
  });

  it('preserves resources arriving while an explicit switch is being saved', async () => {
    await request('first.cdn.test');
    pacKitchen.updatePacMods = async (fn) => {
      mods = await fn(mods);
      await request('late.cdn.test');
      return mods;
    };
    await tracker.setMode(1, 'example.com', false);
    expect(tracker.tabs.get(1).pending.has('late.cdn.test')).to.equal(true);
    await tracker.flush();
    expect(mods.exceptions['late.cdn.test']).to.equal(false);
  });

  it('retries saved rules after PAC failure and a worker restart', async () => {
    await request('video.cdn.test');
    pacSync.reapplyCurrentPac = async () => { throw new Error('Temporary PAC failure'); };
    let error;
    try { await tracker.setMode(1, 'example.com', true); } catch (caught) { error = caught; }
    expect(error.message).to.equal('Temporary PAC failure');
    expect(session['site-resource-tabs'].needsApply).to.equal(true);
    const restored = new SiteResources();
    restored.schedule = () => {};
    await restored.init();
    pacSync.reapplyCurrentPac = async () => { applies++; };
    await restored.flush();
    expect(applies).to.equal(1);
    expect(mods.exceptions['video.cdn.test']).to.equal(true);
    expect(session['site-resource-tabs'].needsApply).to.equal(false);
  });

  it('retains the known hosts across reloads but drops them when leaving the site', async () => {
    await request('video.cdn.test');
    await tracker.setMode(1, 'example.com', false);
    await request('www.example.com', 'main_frame');
    expect((await tracker.summary(1, 'example.com')).needsReload).to.equal(false);
    expect((await tracker.summary(1, 'example.com')).hosts).to.include('video.cdn.test');
    await request('unrelated.test', 'main_frame');
    expect(await tracker.summary(1, 'example.com')).to.equal(null);
    expect((await tracker.summary(1, 'unrelated.test')).hosts).not.to.include('video.cdn.test');
  });

  it('restores session snapshots only for still-open tabs on the same site', async () => {
    await request('video.cdn.test');
    await tracker.flush();
    const restored = new SiteResources();
    expect((await restored.summary(1, 'example.com')).hosts).to.include('video.cdn.test');
    tabs[0].url = 'https://elsewhere.test/';
    const navigated = new SiteResources();
    expect(await navigated.summary(1, 'example.com')).to.equal(null);
  });

  it('does not capture private resources or local/service addresses', async () => {
    await tracker.observe({ tabId: 1, incognito: true, type: 'image', url: 'https://private.test/x' });
    await tracker.init();
    expect((await tracker.summary(1, 'example.com')).count).to.equal(0);
    for (const url of ['file:///secret', 'chrome-extension://abc/page', 'http://localhost/x',
      'http://127.0.0.1/x', 'http://192.168.1.1/x', 'http://[::1]/', 'https://device.local/x']) {
      expect(resourceHost(url)).to.equal('');
    }
    expect(resourceHost('wss://cdn.example.net/socket')).to.equal('cdn.example.net');
  });

  it('bounds stored hosts and rejects a click after the tab navigates', async () => {
    for (let i = 0; i < 310; i++) await request(`cdn${i}.example.net`);
    expect((await tracker.summary(1, 'example.com')).count).to.equal(300);
    expect((await tracker.summary(1, 'example.com')).limited).to.equal(true);
    tabs[0].url = 'https://new-site.test/';
    let error;
    try { await tracker.setMode(1, 'example.com', false); } catch (caught) { error = caught; }
    expect(error).to.be.instanceOf(Error);
    expect(updates).to.equal(0);
  });

  it('leaves resources to standard PAC when no own proxy is configured', async () => {
    mods.filteredCustomsString = '';
    mods.exceptions['example.com'] = true;
    await request('video.cdn.test');
    await tracker.flush();
    expect(updates).to.equal(0);
    await tracker.setMode(1, 'example.com', false);
    expect(mods.exceptions).not.to.have.property('video.cdn.test');
    expect((await tracker.summary(1, 'example.com')).routing).to.equal('domain');
  });

  it('never copies resource rules in Firefox even with an own proxy', async () => {
    const platform = proxyBackend.platform;
    proxyBackend.platform = 'firefox';
    try {
      mods.exceptions['example.com'] = true;
      await request('video.cdn.test');
      await tracker.flush();
      expect(updates).to.equal(0);
      await tracker.setMode(1, 'example.com', false);
      expect(mods.exceptions).not.to.have.property('video.cdn.test');
      expect((await tracker.summary(1, 'example.com')).routing).to.equal('tab');
    } finally { proxyBackend.platform = platform; }
  });

  it('resets rules of the known site/resources and leaves unrelated rules untouched', async () => {
    await request('video.cdn.test');
    await tracker.setMode(1, 'example.com', true);
    mods.exceptions['keep.test'] = false;
    await tracker.setMode(1, 'example.com', null);
    expect(mods.exceptions).to.deep.equal({ 'keep.test': false });
    await tracker.clear();
    expect(tracker.tabs.size).to.equal(0);
    expect(session).not.to.have.property('site-resource-tabs');
  });
});
