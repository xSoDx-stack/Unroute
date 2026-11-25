// Source pages in Chromium with stubbed extension APIs; not an installed-extension smoke test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';

const server = http.createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname;
  if (file === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><main></main>'); return; }
  if (!/^\/(pages|core|vendor)\/[\w./-]+$/.test(file) || file.includes('..')) { res.writeHead(404).end(); return; }
  const target = file.startsWith('/pages/firefox-private-browsing/') ? 'firefox' : 'common';
  try {
    const data = await readFile(new URL(`../../src/${target}${file}`, import.meta.url));
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.setHeader('Content-Type', type); res.end(data);
  } catch { res.writeHead(404).end(); }
});
let browser;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
});
after(async () => { await browser?.close(); server.close(); });
async function open(t, path = '/', setup) {
  const page = await browser.newPage();
  t.after(() => page.close());
  if (setup) await page.evaluateOnNewDocument(setup);
  await page.goto(`http://127.0.0.1:${server.address().port}${path}`);
  return page;
}

test('popup keeps focused native selectors through storage refreshes and catches up after blur', async t => {
  const page = await open(t, '/pages/popup/index.html', () => {
    const listeners = [];
    let hosts = ['cdn.example.test'];
    let route = { origin: 'site', mode: 'direct' };
    window.pushHosts = next => {
      hosts = next;
      for (const listener of listeners) listener({ 'site-resource-tabs': {} }, 'session');
    };
    chrome.tabs = { query(_query, callback) { callback([{ id: 1, url: 'https://example.test/' }]); } };
    chrome.storage = { onChanged: { addListener(fn) { listeners.push(fn); } } };
    chrome.runtime = { sendMessage(message, callback) {
      if (message.action === 'MUTATE_DOMAIN_RULES') {
        window.finishMutation = () => {
          route = { origin: 'manual', mode: 'direct' };
          callback({ success: true });
        };
      } else callback({ success: true, data: {
        version: 'test', pacMods: {}, syncState: { currentPacProviderKey: 'test', isControlled: true },
        siteResources: { hosts, rulesRevision: 1, routes: { 'cdn.example.test': route } },
      } });
    } };
  });
  const resource = 'select[data-host="cdn.example.test"]';
  await page.waitForSelector(resource);
  await page.evaluate(() => { document.getElementById('resourceDetails').open = true; });
  for (const [selector, count] of [['#siteRoute', 2], [resource, 3]]) {
    await page.focus(selector);
    await page.evaluate(count => {
      window.focusedSelect = document.activeElement;
      pushHosts(['cdn.example.test', 'a.test', 'b.test'].slice(0, count));
    }, count);
    await new Promise(resolve => setTimeout(resolve, 250)); // storage refresh is debounced by 100 ms
    assert.equal(await page.evaluate(() => focusedSelect.isConnected && document.activeElement === focusedSelect), true);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction(count => document.querySelectorAll('#resources select').length === count, {}, count);
  }
  await page.focus(resource);
  await page.select(resource, '@direct');
  await page.waitForFunction(() => Boolean(window.finishMutation));
  await page.evaluate(() => finishMutation());
  await page.waitForFunction(selector => document.querySelector(selector).value === '@direct', {}, resource);
  assert.equal(await page.$eval(resource, select => document.activeElement === select), true);
});

test('history blocks overlapping undo across rerenders and handles a non-array response', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const { renderHistory } = await import('/pages/shared/history.js');
    const container = document.querySelector('main');
    let data = [{ id: 'first' }, { id: 'second' }];
    const undo = [];
    chrome.runtime = { sendMessage(message, callback) {
      if (message.action === 'GET_RULE_HISTORY') callback({ success: true, data });
      else undo.push(callback);
    } };
    await renderHistory(container);
    const first = container.querySelector('button');
    first.click();
    const lockedBeforeReload = [...container.querySelectorAll('button')].every(button => button.disabled);
    await renderHistory(container);
    const second = container.querySelectorAll('button')[1];
    const lockedAfterReload = second.disabled;
    second.dispatchEvent(new Event('click'));
    const calls = undo.length;
    undo[0]({ success: false, error: 'no' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const unlocked = [...container.querySelectorAll('button')].every(button => !button.disabled);
    data = { length: 1 };
    try { await renderHistory(container); } catch { return { malformedThrew: true }; }
    return { lockedBeforeReload, lockedAfterReload, calls, unlocked, malformedMessage: Boolean(container.textContent) };
  });
  assert.deepEqual(result, { lockedBeforeReload: true, lockedAfterReload: true, calls: 1, unlocked: true, malformedMessage: true });
});

test('log details are a keyboard disclosure and clipboard fallback cleans up on errors', async t => {
  const page = await open(t);
  await page.evaluate(async () => {
    const { renderLogsView, copyText } = await import('/pages/options/logs-view.js');
    renderLogsView({ logsContainer: document.querySelector('main') }, {
      items: [{ title: 'Entry', details: { value: 1 } }], stats: {},
    }, () => {});
    Object.defineProperty(navigator, 'clipboard', { value: undefined });
    document.execCommand = () => { throw new Error('copy blocked'); };
    try { await copyText('entry'); } catch (error) { window.copyFailure = error.message; }
  });
  const result = await page.evaluate(() => ({ textareas: document.querySelectorAll('textarea').length, error: window.copyFailure }));
  assert.deepEqual(result, { textareas: 0, error: 'copy blocked' });
  const trigger = 'button.log-expand-hint';
  await page.focus(trigger);
  assert.equal(await page.$eval(trigger, button => button.getAttribute('aria-expanded')), 'false');
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval(trigger, button => button.getAttribute('aria-expanded')), 'true');
  await page.keyboard.press('Space');
  assert.equal(await page.$eval(trigger, button => button.getAttribute('aria-expanded')), 'false');
});

test('log renders replace the live list once without scanning for help', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const { renderLogsView } = await import('/pages/options/logs-view.js');
    const container = document.querySelector('main');
    container.append('previous result');
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true });
    const query = Element.prototype.querySelectorAll;
    let queries = 0;
    Element.prototype.querySelectorAll = function (...args) {
      queries++;
      return query.apply(this, args);
    };
    const items = Array.from({ length: 150 }, (_, i) => ({
      timestamp: 1700000000000, title: `Entry ${i}`, category: 'network',
      ...(i === 0 && { details: { value: 1 } }),
    }));
    const stats = { total: items.length };
    function render(entries, search = '', level = 'all') {
      queries = 0;
      renderLogsView({ logsContainer: container }, { items: entries, stats, category: 'all', level, search }, () => {});
      return { queries, mutations: observer.takeRecords().length };
    }
    try {
      const full = render(items);
      const titles = [...query.call(container, '.log-card-title')].map(node => node.textContent);
      const copy = container.querySelector('.log-copy-btn');
      const [withDetails, withoutDetails] = container.children;
      const help = [copy, withDetails].every(node => node.title && node.title === node.getAttribute('aria-description'));
      const copyNamed = copy.getAttribute('aria-label') && copy.getAttribute('aria-label') !== copy.title;
      const plainHasHelp = withoutDetails.hasAttribute('aria-description');
      const filtered = render([items[1]], 'Entry 1');
      const filteredTitle = container.querySelector('.log-card-title').textContent;
      const noResults = render([], 'missing');
      const filteredEmpty = container.textContent;
      const noSeverityResults = render([], '', 'warn');
      const severityEmpty = container.textContent;
      const empty = render([]);
      return { full, filtered, noResults, noSeverityResults, empty, titles, filteredTitle, help, copyNamed, plainHasHelp,
        emptyStatesDiffer: !!container.querySelector('.empty-state') && container.textContent !== filteredEmpty && severityEmpty === filteredEmpty };
    } finally {
      Element.prototype.querySelectorAll = query;
      observer.disconnect();
    }
  });
  const { full, filtered, noResults, empty } = result;
  t.diagnostic(JSON.stringify({ full, filtered, noResults, empty }));
  assert.deepEqual(result.titles, Array.from({ length: 150 }, (_, i) => `Entry ${i}`));
  assert.equal(result.filteredTitle, 'Entry 1');
  assert.equal(result.help, true);
  assert.equal(result.copyNamed, true);
  assert.equal(result.plainHasHelp, false);
  assert.equal(result.emptyStatesDiffer, true);
  for (const counts of [full, filtered, noResults, result.noSeverityResults, empty]) {
    assert.deepEqual(counts, { queries: 0, mutations: 1 });
  }
});

test('dynamic help targets actionable alerts, history undo and application retry', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const { initSettingsHelp, refreshSettingsHelp } = await import('/pages/options/settings-help.js');
    const { renderApplicationBanner } = await import('/pages/shared/application-banner.js');
    const main = document.querySelector('main');
    main.innerHTML = '<div id="toast"></div><div id="homeProxyWarningBanner"></div><div id="historyList"></div><div id="applicationBanner"></div>';
    initSettingsHelp();
    const query = Element.prototype.querySelectorAll;
    let queries = 0;
    Element.prototype.querySelectorAll = function (...args) {
      queries++;
      return query.apply(this, args);
    };
    const described = node => Boolean(node.title && node.title === node.getAttribute('aria-description'));
    try {
      const alerts = ['toast', 'homeProxyWarningBanner'].map(id => {
        const node = document.getElementById(id);
        queries = 0;
        refreshSettingsHelp(node);
        const plain = described(node);
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-label', 'Existing name');
        refreshSettingsHelp(node);
        return { queries, plain, actionable: described(node), name: node.getAttribute('aria-label'), tabIndex: node.tabIndex };
      });
      const history = document.getElementById('historyList');
      const banner = document.getElementById('applicationBanner');
      const update = async (container, render) => {
        queries = 0;
        render();
        await Promise.resolve(); // MutationObserver delivery.
        return { queries, described: described(container.querySelector('button')) };
      };
      const undo = await update(history, () => {
        history.innerHTML = '<div class="history-row"><button disabled aria-describedby="undo-info">Undo</button></div>';
      });
      const button = history.querySelector('button');
      const validation = button.getAttribute('aria-describedby');
      const disabled = button.disabled;
      const retry = await update(banner, () => renderApplicationBanner(banner, { pending: true }, () => {}));
      return { alerts, undo, validation, disabled, retry };
    } finally {
      Element.prototype.querySelectorAll = query;
    }
  });
  t.diagnostic(JSON.stringify(result));
  for (const alert of result.alerts) {
    assert.deepEqual(alert, { queries: 0, plain: false, actionable: true, name: 'Existing name', tabIndex: 0 });
  }
  assert.deepEqual(result.undo, { queries: 1, described: true });
  assert.deepEqual(result.retry, { queries: 1, described: true });
  assert.equal(result.validation, 'undo-info');
  assert.equal(result.disabled, true);
});

test('Firefox private page rereads permission on focus and on becoming visible', async t => {
  const page = await open(t, '/pages/firefox-private-browsing/index.html', () => {
    window.allowed = false;
    chrome.extension = { isAllowedIncognitoAccess(callback) { callback(window.allowed); } };
    chrome.runtime = {};
  });
  await page.waitForSelector('#permissionStatus.denied');
  assert.equal(await page.evaluate(() => {
    window.allowed = true;
    window.dispatchEvent(new Event('focus'));
    return document.querySelector('#permissionStatus').classList.contains('allowed');
  }), true);
  assert.equal(await page.evaluate(() => {
    window.allowed = false;
    document.dispatchEvent(new Event('visibilitychange'));
    return document.querySelector('#permissionStatus').classList.contains('denied');
  }), true);
});

test('list-derived route help identifies the matching list rule', async t => {
  const page = await open(t);
  const help = await page.evaluate(async () => {
    const { resourceOriginHelp } = await import('/pages/popup/resource-proxies.js');
    return resourceOriginHelp({ origin: 'list', ruleKey: '*.cdn.test' });
  });
  assert.match(help, /списка.*\*\.cdn\.test/);
});
