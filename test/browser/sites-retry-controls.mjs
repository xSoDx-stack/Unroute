// Source DOM regression for same-revision recovery. Controlled RPC, not native proof.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--allow-file-access-from-files'],
});
try {
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
  await page.setJavaScriptEnabled(true);
  await page.evaluate(async () => {
    const snapshot = { revision: 4, exceptions: { 'one.test': true }, whitelist: [], pacBypassDomains: [],
      proxyCatalog: [{ id: 'p1', name: 'Alpha', enabled: true }], defaultProxyId: 'p1' };
    window.retryFixture = { fail: false, unchanged: false };
    window.chrome = { runtime: { sendMessage(message, callback) {
      if (message.action === 'GET_DOMAIN_LISTS') return callback({ success: true,
        data: { ...snapshot, lists: [] } });
      if (window.retryFixture.fail) return callback({ success: false, error: 'Simulated read failure' });
      return callback({ success: true, data: window.retryFixture.unchanged
        ? { revision: snapshot.revision, unchanged: true, proxyCatalog: snapshot.proxyCatalog, defaultProxyId: 'p1' }
        : snapshot });
    } } };
    const { initSitesEditor } = await import('./sites-editor.js');
    document.querySelector('#tab-exceptions').classList.add('active');
    window.retryEditor = initSitesEditor(document.querySelector('#tab-exceptions'), { notify() {}, onApplicationState() {} });
    await window.retryEditor.activate();
    document.getElementById('manualRulesLink').click();
  });
  await page.waitForFunction(() => !document.getElementById('newDomainInput').disabled);
  await page.evaluate(async () => { window.retryFixture.fail = true; await window.retryEditor.refresh(); });
  assert.equal(await page.$eval('#addDomainBtn', button => button.disabled), true);
  await page.evaluate(() => { window.retryFixture.fail = false; window.retryFixture.unchanged = true; });
  const originalRow = await page.$('#manualSitesEditor .domain-card');
  await page.click('#retrySitesLoad');
  await page.waitForFunction(() => document.getElementById('retrySitesLoad').hidden);
  assert.equal(await page.$eval('#newDomainInput', input => input.disabled), false, 'same-revision retry must restore editing');
  assert.equal(await page.$eval('#addDomainBtn', button => button.disabled), false, 'same-revision retry must restore saving');
  assert.equal(await originalRow.evaluate(row => row === document.querySelector('#manualSitesEditor .domain-card')), true,
    'recovery must retain existing rows, not redraw the same revision');
  console.log('PASS same-revision retry: inputs and save controls re-enabled, confirmed rows retained');
} finally {
  await browser.close();
}
