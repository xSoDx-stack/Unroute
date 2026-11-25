import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1100, height: 800});
  await page.setJavaScriptEnabled(false);
  await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
  await page.setJavaScriptEnabled(true);
  await page.evaluate(async () => {
    const f = window.fixture = {
      revision: 1, writes: [],
      lists: Array.from({length: 30}, (_, i) => ({id: `l${i}`, name: `List ${i}`, proxyId: 'p1', enabled: true, count: 1})),
      exceptions: Object.fromEntries(Array.from({length: 100000}, (_, i) => [`d${String(99999 - i).padStart(5, '0')}.test`, true])),
      proxyCatalog: [{id: 'p1', name: 'Alpha', enabled: true}, {id: 'p2', name: 'Beta', enabled: true}],
      ruleMeta: {'exception:d99998.test': {source: 'popup'}}, domainProxyIds: {'d99998.test': 'p2'},
    };
    window.chrome = {runtime: {sendMessage(message, done) {
      const {revision, lists, exceptions, proxyCatalog, ruleMeta, domainProxyIds} = f;
      if (message.action === 'GET_DOMAIN_LISTS') return done({success: true, data: {revision, lists, proxyCatalog}});
      if (message.action === 'GET_EXCEPTIONS') return done({success: true, data: {revision, exceptions, proxyCatalog, ruleMeta, domainProxyIds, defaultProxyId: 'p1'}});
      f.writes.push(message);
      if (message.action === 'REORDER_DOMAIN_LISTS') {
        f.lists = message.listIds.map(id => lists.find(list => list.id === id));
        f.revision++;
      }
      done({success: true});
    }}};
    const {initSitesEditor} = await import('./sites-editor.js');
    const root = document.querySelector('#tab-exceptions');
    root.classList.add('active');
    window.editor = initSitesEditor(root, {notify(){}, onApplicationState(){}, navigate(){}});
    await window.editor.activate();
  });

  const mode = process.argv[2];
  if (!mode || mode === 'search') {
    await page.click('#manualRulesLink');
    await page.waitForSelector('.domain-card');
    const burst = await page.evaluate(() => {
      const list = document.querySelector('#domainListContainer');
      const input = document.querySelector('#searchDomainInput');
      const initial = list.firstElementChild;
      const sort = Array.prototype.sort;
      const observer = new MutationObserver(records => { window.searchWork.records += records.length; });
      observer.observe(list, {childList: true});
      window.searchWork = {sorts: 0, observer, records: 0, restore: () => { Array.prototype.sort = sort; }};
      Array.prototype.sort = function (...args) {
        if (this.length > 100 && typeof this[0] === 'string') window.searchWork.sorts++;
        return sort.apply(this, args);
      };

      const start = performance.now();
      for (const value of ['d', 'd9', 'd99', ' D999 ']) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
      }
      window.searchWork.records = observer.takeRecords().length;
      return {sameCard: list.firstElementChild === initial, sorts: window.searchWork.sorts, records: window.searchWork.records, inputMs: performance.now() - start};
    });
    console.log('100k domain search burst:', burst);
    assert.equal(burst.sameCard, true, 'typing should not synchronously replace cards');
    await page.waitForFunction(() => document.querySelector('.domain-name')?.textContent === 'd99900.test');
    const selected = await page.evaluate(() => {
      const work = window.searchWork;
      work.restore();
      work.records += work.observer.takeRecords().length;
      work.observer.disconnect();
      const list = document.querySelector('#domainListContainer');
      const card = list.children[10];
      const checkbox = card.querySelector('.domain-select');
      const selectAll = document.querySelector('#selectAllFiltered');
      list.scrollTop = 200;
      checkbox.focus({preventScroll: true});
      const scroll = list.scrollTop;
      checkbox.click();
      const partial = selectAll.indeterminate;
      selectAll.click();
      const all = selectAll.checked && list.querySelectorAll('.domain-select:checked').length === 100;
      document.querySelector('#clearSelection').click();
      return {sorts: work.sorts, records: work.records, partial, all, sameCard: list.children[10] === card, focused: document.activeElement === checkbox, scroll, finalScroll: list.scrollTop, checked: list.querySelectorAll('.domain-select:checked').length,
        first: list.firstElementChild.querySelector('.domain-name').textContent, last: list.lastElementChild.querySelector('.domain-name').textContent};
    });
    console.log('100k domain search and selection:', selected);
    assert.deepEqual(selected, {sorts: 0, records: 2, partial: true, all: true, sameCard: true, focused: true, scroll: 200, finalScroll: 200, checked: 0, first: 'd99900.test', last: 'd99999.test'});
    await page.evaluate(() => {
      const input = document.querySelector('#searchDomainInput');
      input.value = 'D9999'; input.dispatchEvent(new Event('input'));
      const filter = document.querySelector('#proxyFilter');
      filter.value = 'p2'; filter.dispatchEvent(new Event('change'));
    });
    assert.deepEqual(await page.$$eval('.domain-name', nodes => nodes.map(node => node.textContent)), ['d99998.test']);
    await page.evaluate(async () => {
      const input = document.querySelector('#searchDomainInput');
      input.value = 'new'; input.dispatchEvent(new Event('input'));
      window.fixture.exceptions = {'new.test': true}; window.fixture.domainProxyIds = {};
      window.fixture.revision++;
      document.querySelector('#proxyFilter').value = '';
      await window.editor.refresh();
    });
    assert.deepEqual(await page.$$eval('.domain-name', nodes => nodes.map(node => node.textContent)), ['new.test']);
  }

  if (!mode || mode === 'drag') {
    if (!mode) await page.click('#domainListsBack');
    const burst = await page.evaluate(() => {
      const rows = document.querySelector('#domainListsRows');
      const first = rows.querySelector('[data-list-id="l0"]');
      const handle = first.querySelector('.domain-list-handle');
      const point = node => { const box = node.getBoundingClientRect(); return {clientX: box.left + box.width / 2, clientY: box.top + box.height / 2}; };
      const from = point(handle), to = point(rows.querySelector('[data-list-id="l3"] .domain-list-handle'));
      to.clientY += 3;
      const rect = Element.prototype.getBoundingClientRect;
      let reads = 0;
      Element.prototype.getBoundingClientRect = function () { if (this.matches('.domain-list-row')) reads++; return rect.call(this); };
      const fire = (target, type, position) => target.dispatchEvent(new PointerEvent(type, {pointerId: 1, button: 0, bubbles: true, cancelable: true, ...position}));
      fire(handle, 'pointerdown', from);
      for (let i = 0; i < 24; i++) fire(document, 'pointermove', to);
      window.dragProbe = {reads: () => reads, fire, from, to, handle, restore: () => { Element.prototype.getBoundingClientRect = rect; }};
      return {reads, first: rows.firstElementChild.dataset.listId};
    });
    console.log('30-row drag burst, 24 moves before paint:', burst);
    assert.deepEqual(burst, {reads: 1, first: 'l0'}, 'pointer burst should defer preview to a frame');
    const preview = await page.evaluate(async () => {
      const {reads, fire, to} = window.dragProbe;
      await new Promise(requestAnimationFrame);
      const afterFirst = reads();
      for (let i = 0; i < 24; i++) fire(document, 'pointermove', to);
      await new Promise(requestAnimationFrame);
      return {afterFirst, steadyReads: reads() - afterFirst};
    });
    console.log('30-row drag frame reads:', preview);
    assert(preview.afterFirst <= 61);
    assert.equal(preview.steadyReads, 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement === window.dragProbe.handle && window.fixture.writes.length === 0 && document.querySelector('#domainListsRows').firstElementChild.dataset.listId === 'l0'), true);
    const dragRevision = await page.evaluate(() => {
      const {fire, from, to, handle, restore} = window.dragProbe;
      const revision = window.fixture.revision;
      fire(handle, 'pointerdown', from);
      fire(document, 'pointermove', to);
      fire(document, 'pointerup', to); // release before the queued preview runs
      restore();
      return revision;
    });
    await page.waitForFunction(() => window.fixture.writes.length === 1 && document.activeElement.closest('[data-list-id]')?.dataset.listId === 'l0');
    assert.deepEqual(await page.evaluate(() => window.fixture.writes.filter(write => write.action === 'REORDER_DOMAIN_LISTS').map(({expectedRevision, listIds}) => [expectedRevision, listIds.slice(0, 4)])), [[dragRevision, ['l1', 'l2', 'l3', 'l0']]]);
  }

  if (!mode || mode === 'focus') {
    const result = await page.evaluate(async () => {
      document.querySelector('#tab-exceptions').classList.remove('active');
      document.querySelector('#tab-proxies').classList.add('active');
      const {initProxiesPanel} = await import('./proxies-panel.js');
      const endpoint = host => `PROXY ${host}:8080`;
      const appState = {pacMods: {
        customProxyStringRaw: 'PROXY alpha.test:8080; PROXY beta.test:8080',
        proxyCatalog: [{id:'a', name:'Alpha', enabled:true, endpoint:endpoint('alpha.test')}, {id:'b', name:'Beta', enabled:true, endpoint:endpoint('beta.test')}],
        defaultProxyId: 'a',
      }, proxyHealthMap: {}};
      const panel = initProxiesPanel(document, {appState, setActionableErrorElement(){}});
      panel.render();
      const list = document.querySelector('#proxyCardsList');
      list.querySelector('.delete-btn').click();
      const replacement = list.querySelector('.proxy-profile-editor select');
      replacement.value = 'b'; replacement.dispatchEvent(new Event('change'));
      replacement.focus();
      const cards = [...list.children];
      const option = document.querySelector('#defaultProxySelect option');
      const raw = 'HTTP alpha.test:8080';
      appState.proxyHealthMap[raw] = {ok: true, checkedAt: Date.now(), latency: 22};
      panel.render();
      return {focused: document.activeElement === replacement, value: replacement.value,
        sameCards: cards.every((card, i) => card === list.children[i]),
        sameOption: option === document.querySelector('#defaultProxySelect option'),
        healthy: Boolean(list.querySelector('.proxy-status-tag.online'))};
    });
    assert.deepEqual(result, {focused:true, value:'b', sameCards:true, sameOption:true, healthy:true});
  }
} finally {
  await browser.close();
}
