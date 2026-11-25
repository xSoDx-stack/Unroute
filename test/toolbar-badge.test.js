import { expect } from 'chai';
import { badgePresentation, ToolbarBadge } from '../src/common/core/toolbar-badge.js';

describe('Selected site mode on the toolbar', () => {
  let originalChrome;
  let state;
  let tabs;
  let writes;
  let queries;
  let lookups;
  let listeners;
  let toolbar;
  beforeEach(() => {
    originalChrome = globalThis.chrome;
    state = { sync: { currentPacProviderKey: 'onlyOwnSites', levelOfControl: 'controlled_by_this_extension' },
      mods: { exceptions: { 'proxy.test': true, 'direct.test': false, '*.wild.test': false } },
      application: { pending: false, error: '', applying: false } };
    tabs = [{ id: 1, url: 'https://proxy.test/' }, { id: 2, url: 'https://direct.test/' }];
    writes = [];
    queries = [];
    lookups = [];
    listeners = {};
    const event = name => ({ addListener: listener => { listeners[name] = listener; } });
    globalThis.chrome = { runtime: {}, tabs: {
      query: (query, callback) => { queries.push(query); callback(tabs); },
      get: (id, callback) => { lookups.push(id); callback(tabs.find(tab => tab.id === id)); },
      onUpdated: event('updated'),
      onActivated: event('activated'), onCreated: event('created'), onRemoved: event('removed'),
    }, storage: { onChanged: event('storage') }, action: Object.fromEntries(
      ['setBadgeText', 'setBadgeBackgroundColor', 'setBadgeTextColor', 'setTitle'].map(method =>
        [method, (details, callback) => { writes.push({ method, ...details }); callback(); }])) };
    toolbar = new ToolbarBadge(async () => state);
  });
  afterEach(() => {
    if (toolbar.timer !== null) clearTimeout(toolbar.timer);
    globalThis.chrome = originalChrome;
  });
  const presentation = url => badgePresentation(url, state);
  const flush = async () => {
    if (toolbar.timer !== null) clearTimeout(toolbar.timer);
    toolbar.timer = null;
    await toolbar.drain();
  };

  it('shows P, D and PAC for selected rules, including exact and wildcard subdomains', () => {
    expect(presentation('https://proxy.test/').text).to.equal('P');
    expect(presentation('https://direct.test/').text).to.equal('D');
    expect(presentation('https://other.test/').text).to.equal('PAC');
    expect(presentation('https://images.wild.test/').text).to.equal('D');
    state.mods.exceptions['images.proxy.test'] = false;
    expect(presentation('https://images.proxy.test/').text).to.equal('D');
    state.mods.ifMindExceptions = false;
    expect(presentation('https://proxy.test/').text).to.equal('PAC');
  });

  it('explains the selected mode without retaining URL paths, queries or proxy credentials', () => {
    state.mods.customProxyStringRaw = 'HTTP user:password@own.test:8080';
    const result = presentation('https://proxy.test/private?token=secret');
    expect(result.title).to.include('proxy.test').and.include('Выбрано: через прокси')
      .and.include('Для отдельных ресурсов');
    expect(result.title).not.to.include('secret').and.not.to.include('password').and.not.to.include('/private');
  });

  it('clears disabled and internal pages and gives errors precedence over site modes', () => {
    expect(presentation('chrome://extensions/').text).to.equal('');
    expect(presentation('file:///private.txt').text).to.equal('');
    state.application = { pending: true, error: 'Apply failed', applying: false };
    expect(presentation('https://proxy.test/').text).to.equal('!');
    state.application.applying = true;
    expect(presentation('https://proxy.test/').text).to.equal('P');
    state.sync.currentPacProviderKey = 'none';
    expect(presentation('https://proxy.test/').text).to.equal('');
    expect(presentation('https://proxy.test/').title).to.include('Отключено');
  });

  it('shows loss of proxy control and returns to the selected mode after recovery', () => {
    state.sync.levelOfControl = 'controlled_by_other_extensions';
    expect(presentation('https://direct.test/').text).to.equal('!');
    state.sync.levelOfControl = 'controlled_by_this_extension';
    expect(presentation('https://direct.test/').text).to.equal('D');
  });

  it('updates unchanged tabs once and restores properties reset by navigation', async () => {
    toolbar.setup();
    await flush();
    expect(writes.filter(item => item.method === 'setBadgeText').map(item => item.text)).to.deep.equal(['P', 'D']);
    const firstWrites = writes.length;
    listeners.activated({ tabId: 1 });
    await flush();
    expect(writes.length).to.equal(firstWrites);
    listeners.updated(1, { status: 'complete' });
    await flush();
    expect(writes.length).to.equal(firstWrites + 4);
    state.mods.exceptions['proxy.test'] = false;
    listeners.storage({ 'pac-kitchen-mods': {} }, 'local');
    await flush();
    expect(writes.filter(item => item.method === 'setBadgeText').at(-1)).to.include({ tabId: 1, text: 'D' });
  });

  it('refreshes a newly created background tab without querying all tabs again', async () => {
    toolbar.setup();
    await flush();
    writes.length = 0;
    const tab = { id: 3, active: false, pendingUrl: 'https://proxy.test/' };
    tabs.push(tab);
    listeners.created(tab);
    await flush();

    expect(queries).to.deep.equal([{}]);
    expect(lookups).to.deep.equal([tab.id]);
    expect(writes).to.have.length(4);
    expect(writes.every(write => write.tabId === tab.id)).to.equal(true);
    expect(writes.find(write => write.method === 'setBadgeText')).to.include({ text: 'P' });
  });

  it('coalesces navigation and activation into lookups of only the affected tabs', async () => {
    toolbar.setup();
    await flush();
    writes.length = 0;
    tabs[0].pendingUrl = 'https://other.test/';
    listeners.updated(1, { status: 'loading' });
    listeners.updated(1, { url: tabs[0].pendingUrl });
    listeners.updated(1, { status: 'complete' });
    listeners.activated({ tabId: 2 });
    listeners.updated(2, { title: 'Ignored' });
    await flush();
    expect(queries).to.deep.equal([{}]);
    expect(lookups).to.deep.equal([1, 2]);
    expect(writes.filter(item => item.method === 'setBadgeText')).to.deep.equal([
      { method: 'setBadgeText', tabId: 1, text: 'PAC' },
    ]);
  });

  it('discards a read superseded by navigation and clears all badges when disabled', async () => {
    toolbar.setup();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    toolbar.readState = () => {
      toolbar.readState = async () => state;
      started();
      return new Promise(resolve => { release = resolve; });
    };
    const loading = flush();
    await ready;
    tabs[0].url = 'https://direct.test/';
    listeners.updated(1, { url: tabs[0].url });
    release(state);
    await loading;
    expect(writes.filter(item => item.method === 'setBadgeText').map(item => item.text)).to.deep.equal(['D', 'D']);
    state.sync.currentPacProviderKey = 'none';
    listeners.storage({ antiCensorRu: {} }, 'local');
    await flush();
    expect(writes.filter(item => item.method === 'setBadgeText').slice(-2).every(item => item.text === '')).to.equal(true);
    expect(queries).to.deep.equal([{}, {}]);
    expect(lookups).to.deep.equal([1]);
  });

  it('does not write a superseded tab lookup or repaint unrelated tabs', async () => {
    toolbar.setup();
    await flush();
    writes.length = 0;
    const get = chrome.tabs.get;
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    chrome.tabs.get = (id, callback) => {
      const snapshot = { ...tabs[0] };
      chrome.tabs.get = get;
      release = () => callback(snapshot);
      started(id);
    };

    listeners.updated(1, { status: 'loading' });
    const loading = flush();
    expect(await ready).to.equal(1);
    tabs[0].url = 'https://direct.test/';
    listeners.updated(1, { url: tabs[0].url });
    release();
    await loading;
    expect(queries).to.deep.equal([{}]);
    expect(writes.filter(item => item.method === 'setBadgeText')).to.deep.equal([
      { method: 'setBadgeText', tabId: 1, text: 'D' },
    ]);
  });

  it('uses a new global snapshot when settings change during a targeted lookup', async () => {
    toolbar.setup();
    await flush();
    writes.length = 0;
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    chrome.tabs.get = (id, callback) => {
      release = () => callback(tabs.find(tab => tab.id === id));
      started();
    };

    listeners.updated(1, { status: 'complete' });
    const loading = flush();
    await ready;
    state = { ...state, sync: { currentPacProviderKey: 'none' } };
    listeners.storage({ antiCensorRu: {} }, 'local');
    release();
    await loading;
    expect(queries).to.deep.equal([{}, {}]);
    expect(writes.filter(item => item.method === 'setBadgeText')).to.deep.equal([
      { method: 'setBadgeText', tabId: 1, text: '' },
      { method: 'setBadgeText', tabId: 2, text: '' },
    ]);
  });

  it('does not repaint a removed tab returned by an in-flight global query', async () => {
    toolbar.setup();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    chrome.tabs.query = (_query, callback) => {
      const snapshot = tabs.slice();
      release = () => callback(snapshot);
      started();
    };

    const loading = flush();
    await ready;
    tabs.shift();
    listeners.removed(1);
    release();
    await loading;
    expect(writes.map(item => item.tabId)).to.deep.equal([2, 2, 2, 2]);
    expect(toolbar.presentations.has(1)).to.equal(false);
  });
});
