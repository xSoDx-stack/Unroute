import assert from 'node:assert/strict';
import { sendChromeMessage } from './chrome-rpc.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { verifySettingsLayout } from './ui-layout-scenario.js';
import { verifyPopupRecovery } from './popup-recovery-scenario.js';

export async function verifySiteResources(browser, optionsPage, proxy, credentials) {
  const polling = { polling: 100, timeout: 15000 };
  const chooseMode = async mode => {
    const value = mode === 'proxy' ? await popup.$eval('#siteRoute', select =>
      [...select.options].find(option => !option.disabled && !option.value.startsWith('@'))?.value) : '@' + mode;
    assert.ok(value, 'Proxy fixture requires an enabled named profile');
    await popup.select('#siteRoute', value);
    await popup.waitForFunction(value => document.getElementById('siteRoute').value === value &&
      !document.getElementById('siteRoute').disabled && document.body.getAttribute('aria-busy') === 'false', polling, value);
  };
  const checkSelectedMode = async selectedId => {
    const selected = await popup.$eval('#siteRoute', select => ({ value: select.value, disabled: select.disabled }));
    assert.equal(selected.disabled, false);
    assert.equal(await popup.$$eval('[data-mode]', nodes => nodes.length), 0);
    if (selectedId === 'proxy') assert.ok(selected.value && !selected.value.startsWith('@'));
    else assert.equal(selected.value, '@' + selectedId);
    const badge = { proxy: 'P', direct: 'D', pac: 'PAC' }[selectedId];
    await optionsPage.waitForFunction(({ id, text }) => new Promise(resolve => {
      chrome.action.getBadgeText({ tabId: id }, value => resolve(value === text));
    }), polling, { id: siteTabId, text: badge });
    const title = await optionsPage.evaluate(id => new Promise(resolve => {
      chrome.action.getTitle({ tabId: id }, resolve);
    }), siteTabId);
    assert.ok(title.includes('site.example.test'));
    assert.ok(title.includes(await optionsPage.evaluate(() => chrome.i18n.getMessage('badgeModeHint'))));
  };
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/') {
      const port = server.address().port;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<html><body><h1>Resource routing fixture</h1>
        <img src="http://images.cdn.test:${port}/image">
        <script src="http://api.cdn.test:${port}/script"></script></body></html>`);
    } else if (request.url === '/script') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('window.fixtureReady = true;');
    } else if (request.url === '/image') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
    } else response.end('origin-direct');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const send = message => sendChromeMessage(optionsPage, message);
  let site;
  let probe;
  let popup;
  let siteTabId;
  try {
    assert.equal((await send({ action: 'SAVE_MODS', mods: {
      exceptions: {}, ifUseSecureProxiesOnly: false,
      customProxyStringRaw: `HTTP ${credentials.username}:${credentials.password}@127.0.0.1:${proxy.port}`,
    } })).success, true);
    assert.equal((await send({ action: 'SET_RAW_PAC',
      pacData: 'function FindProxyForURL() { return "DIRECT"; }' })).success, true);
    site = await browser.newPage();
    await site.goto(`http://site.example.test:${port}/`);
    await site.waitForFunction(() => window.fixtureReady === true, polling);
    const tabId = await optionsPage.evaluate(() => new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => resolve(tabs.find((tab) => tab.url?.includes('site.example.test'))?.id));
    }));
    assert.ok(Number.isInteger(tabId));
    siteTabId = tabId;
    const state = await send({ action: 'GET_STATE', currentDomain: 'example.test', currentTabId: tabId });
    assert.ok(state.data.siteResources.hosts.includes('images.cdn.test'));
    assert.ok(state.data.siteResources.hosts.includes('api.cdn.test'));
    popup = await browser.newPage();
    // The fixture intentionally keeps the site foregrounded for tab routing.
    // Background-tab CSS transitions can remain suspended; assert final states
    // with the same reduced-motion setting supported by the actual UI.
    await popup.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await popup.setViewport({ width: 360, height: 600, deviceScaleFactor: 1 });
    await popup.goto(new URL('../popup/index.html', optionsPage.url()).href);
    await site.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('domain').textContent === 'example.test', polling);
    await checkSelectedMode('pac');
    // Wait until the initial observation batch has been consumed, then add
    // only the main domain through the editor's message path.
    await optionsPage.waitForFunction((id) => new Promise(resolve => {
      chrome.storage.session.get('site-resource-tabs', stored => resolve(
        stored['site-resource-tabs']?.[id]?.hosts.includes('images.cdn.test')));
    }), polling, tabId);
    assert.equal((await send({ action: 'SET_SINGLE_EXCEPTION', domain: 'example.test', isProxy: true })).success, true);
    await optionsPage.waitForFunction(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, res => resolve(
        res?.data?.exceptions?.['images.cdn.test'] === true && res?.data?.exceptions?.['api.cdn.test'] === true));
    }), polling);
    await chooseMode('proxy');
    let rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    await checkSelectedMode('proxy');
    assert.equal(rules['images.cdn.test'], true);
    assert.equal(rules['api.cdn.test'], true);
    probe = await browser.newPage();
    let response = await probe.goto(`http://images.cdn.test:${port}/probe`);
    assert.equal(await response.text(), proxy.marker);
    await probe.close();
    probe = null;

    await site.bringToFront();
    await chooseMode('direct');
    rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    assert.equal(rules['images.cdn.test'], false);
    assert.equal(rules['api.cdn.test'], false);
    await site.evaluate((url) => fetch(url).then((res) => res.text()), `http://late.cdn.test:${port}/probe`);
    await optionsPage.waitForFunction(() => new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, (res) => resolve(res?.data?.exceptions?.['late.cdn.test'] === false));
    }), polling);
    probe = await browser.newPage();
    response = await probe.goto(`http://images.cdn.test:${port}/probe`);
    assert.equal(await response.text(), 'origin-direct');
    await probe.close();
    probe = null;
    await site.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('domain').textContent === 'example.test', polling);
    const imageDir = path.resolve('artifacts/ui-check');
    fs.mkdirSync(imageDir, { recursive: true });
    await checkSelectedMode('direct');
    await chooseMode('pac');
    rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    assert.equal(rules['images.cdn.test'], undefined);
    assert.equal(rules['late.cdn.test'], undefined);
    await checkSelectedMode('pac');
    assert.ok(await popup.$eval('#actionScope', text => text.textContent.includes(chrome.i18n.getMessage('msg_for_the_site_and_detected_resources_resource__f49ef3e9'))));
    await popup.$eval('#resourceDetails summary', summary => summary.click());
    const visibleHosts = await popup.$$eval('#resources .resource-domain', items => items.map(item => item.textContent));
    assert.ok(visibleHosts.includes('images.cdn.test'));
    assert.ok(visibleHosts.includes('api.cdn.test'));
    await popup.$eval('#resourceDetails summary', summary => summary.click());
    await chooseMode('proxy');
    await checkSelectedMode('proxy');
    const popupRules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    for (const domain of ['example.test', 'images.cdn.test', 'api.cdn.test']) assert.equal(popupRules[domain], true);
    const operation = (await send({ action: 'GET_RULE_HISTORY' })).data.find(item => item.source === 'site' && !item.undoneAt);
    assert.ok(operation);
    assert.equal((await send({ action: 'SET_SINGLE_EXCEPTION', domain: 'images.cdn.test', isProxy: false })).success, true);
    const undo = await send({ action: 'UNDO_RULE_CHANGE', id: operation.id });
    assert.equal(undo.success, true);
    assert.ok(undo.data.skipped >= 1);
    rules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    assert.equal(rules['example.test'], undefined);
    assert.equal(rules['images.cdn.test'], false);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('domain').textContent === 'example.test', polling);
    await chooseMode('direct');
    const directRules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    for (const domain of ['example.test', 'images.cdn.test', 'api.cdn.test']) assert.equal(directRules[domain], false);
    assert.equal(await popup.$eval('#reload', button => button.hidden), false);
    // Hidden extension pages may never submit a frame for capture in headless
    // Chrome. Restore the fixture tab before testing active-tab actions.
    await popup.bringToFront();
    await popup.screenshot({ path: path.join(imageDir, 'popup-redesign.png') });
    await site.bringToFront();
    assert.ok(await popup.evaluate(() => document.documentElement.scrollHeight <= 600), 'Collapsed popup must fit the toolbar height');
    await verifyPopupRecovery(popup);
    await chooseMode('pac');
    const pacRules = (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions;
    for (const domain of ['example.test', 'api.cdn.test']) assert.equal(pacRules[domain], undefined);
    assert.equal(pacRules['images.cdn.test'], false, 'PAC reset must preserve the independently edited manual CDN rule');
    assert.equal((await send({ action: 'SAVE_MODS', mods: { ifProxyHttpsUrlsOnly: true, ifMindWhitelist: true, whitelist: ['example.test'] } })).success, true);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('actionScope').textContent.includes(chrome.i18n.getMessage('msg_restrictions_sub_requests_outside_these_restr_190f99dc', ['HTTPS']).split('HTTPS')[1].trim()), polling);
    assert.equal((await send({ action: 'SAVE_MODS', mods: { ifProxyHttpsUrlsOnly: false, ifMindWhitelist: false, whitelist: [] } })).success, true);
    await optionsPage.setViewport({ width: 1160, height: 860, deviceScaleFactor: 1 });
    await optionsPage.goto(new URL('#history', optionsPage.url()).href);
    await optionsPage.reload();
    await optionsPage.waitForFunction(() => document.querySelector('#historyList .history-row'), polling);
    await optionsPage.evaluate(() => document.querySelectorAll('*').forEach(node => {
      node.style.animation = 'none'; node.style.transition = 'none';
    }));
    await optionsPage.bringToFront();
    await optionsPage.screenshot({ path: path.join(imageDir, 'settings-redesign.png') });
    await site.bringToFront();
    assert.ok(await optionsPage.evaluate(() => document.body.getBoundingClientRect().width > 800));
    assert.equal((await send({ action: 'IMPORT_EXCEPTIONS_BATCH', target: 'excluded',
      domains: Array.from({ length: 50001 }, (_, index) => `bulk-${index}.test`) })).success, true);
    await popup.reload();
    assert.equal(await popup.$('#lastChange'), null, 'History is only available in settings');
    assert.equal(await popup.$('#undo'), null, 'Popup must not offer rule undo');
    await optionsPage.reload();
    await optionsPage.waitForFunction(() => document.querySelector('#historyList .history-row small')?.textContent.includes('50001'), polling);
    assert.equal(await optionsPage.$eval('#historyList .history-row button', button => button.disabled), true, 'Oversized operations must not offer undo');
    assert.equal(await optionsPage.$$eval('#historyList .history-row', rows => rows.length), 5, 'Settings retain only the five latest operations');
    assert.equal((await send({ action: 'CLEAR_RULE_HISTORY' })).success, true);
    assert.deepEqual((await send({ action: 'GET_RULE_HISTORY' })).data, []);
    await popup.close();
    popup = null;
    await verifySettingsLayout(optionsPage, new URL('../../', optionsPage.url()).href);
    probe = await browser.newPage();
    await probe.setRequestInterception(true);
    probe.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<html><body>IP fixture</body></html>' }));
    await probe.goto('http://8.8.8.88/');
    await probe.bringToFront();
    await optionsPage.reload();
    await optionsPage.waitForFunction(() => document.getElementById('extVersion')?.textContent.trim(), polling);
    assert.equal(await optionsPage.$('#currentSiteWidget'), null);
    console.log('Whole-site routing passed: discovery, UI, proxy/direct traffic, late resources, and reset.');
  } finally {
    if (popup) await popup.close();
    if (probe) await probe.close();
    if (site) await site.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
