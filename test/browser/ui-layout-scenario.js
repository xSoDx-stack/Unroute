import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifySettingsLayout(page, base, browserName = 'chrome') {
  const polling = { polling: 100, timeout: 15000 };
  const output = path.resolve('artifacts/ui-check');
  fs.mkdirSync(output, { recursive: true });
  await page.bringToFront();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  if (browserName === 'chrome') await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  if (browserName === 'chrome') {
    await page.goto(new URL('pages/options/index.html#pac', base).href);
    await page.reload();
  }
  await page.waitForFunction(() => document.querySelector('#tab-pac.active') && document.getElementById('extVersion').textContent, polling);
  const checkFits = async section => {
    const size = await page.evaluate(() => {
      const scrolling = document.scrollingElement, previous = scrolling.scrollTop;
      scrolling.scrollTop = scrolling.scrollHeight;
      const footer = document.querySelector('.statusbar').getBoundingClientRect();
      const result = { width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight, availableWidth: innerWidth, availableHeight: innerHeight,
        scrollable: getComputedStyle(document.documentElement).overflowY !== 'hidden' && getComputedStyle(document.body).overflowY !== 'hidden',
        footerReachable: footer.bottom <= innerHeight + 1 && footer.bottom <= document.body.getBoundingClientRect().bottom + 1 };
      scrolling.scrollTop = previous;
      return result;
    });
    if (size.width > size.availableWidth || !size.scrollable || !size.footerReachable) {
      await page.screenshot({ path: path.join(output, `${browserName}-overflow.png`) });
    }
    assert.ok(size.width <= size.availableWidth, `${browserName}/${section}: horizontal overflow ${JSON.stringify(size)}`);
    assert.ok(size.scrollable && size.footerReachable, `${browserName}/${section}: document scrolling must reach the 01 footer ${JSON.stringify(size)}`);
  };
  await checkFits('PAC');
  await page.screenshot({ path: path.join(output, `${browserName}-settings-pac.png`) });
  await page.$eval('[data-tab="proxies"]', button => button.click());
  await checkFits('proxies');
  assert.equal(await page.$eval('#proxyAdvanced', details => details.open), false);
  const rows = await page.$$eval('.proxy-endpoint-fields .form-group', fields => fields.map(field => field.getBoundingClientRect().top));
  assert.ok(Math.max(...rows) - Math.min(...rows) < 1, 'Protocol, host and port should share a row');
  await page.screenshot({ path: path.join(output, `${browserName}-settings-proxies.png`) });
  await page.$eval('#proxyHost', input => { input.value = 'draft.example.test'; });
  await page.$eval('#proxyAuthCheck', input => { if (!input.checked) input.click(); });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('proxyAuthFields')).display !== 'none', polling);
  await page.$eval('#proxyUser', input => { input.value = 'draft-user'; });
  await page.$eval('#proxyEditorModeToggle', button => button.click());
  assert.equal(await page.$eval('#proxyRawView', view => getComputedStyle(view).display), 'block');
  const savedRaw = await page.$eval('#customProxyText', input => { input.focus(); return input.value; });
  const otherView = await page.browser().newPage();
  await otherView.goto(new URL('pages/options/index.html#proxies', base).href);
  await page.bringToFront();
  const otherSave = raw => otherView.evaluate(value => new Promise(resolve => chrome.runtime.sendMessage({
    action: 'SAVE_MODS', mods: { customProxyStringRaw: value },
  }, resolve)), raw);
  const changedRaw = [savedRaw, 'HTTPS secondary-ui.test:443'].filter(Boolean).join('\n');
  assert.equal((await otherSave(changedRaw)).success, true);
  await page.waitForFunction(value => document.getElementById('customProxyText').value === value, polling, changedRaw);
  assert.equal((await otherSave(savedRaw)).success, true);
  await page.waitForFunction(value => document.getElementById('customProxyText').value === value, polling, savedRaw);
  await page.$eval('#proxyEditorModeToggle', button => button.click());
  assert.equal(await page.$eval('#proxyHost', input => input.value), 'draft.example.test');
  assert.equal(await page.$eval('#proxyUser', input => input.value), 'draft-user');
  await page.$eval('#proxyEditorModeToggle', button => button.click());
  await page.$eval('#customProxyText', input => { input.value = 'HTTP draft.example.test:8123'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#proxyEditorModeToggle', button => button.click());
  await page.$eval('#proxyEditorModeToggle', button => button.click());
  assert.equal(await page.$eval('#customProxyText', input => input.value), 'HTTP draft.example.test:8123');
  assert.equal((await otherSave(changedRaw)).success, true);
  await page.waitForFunction(() => document.getElementById('proxyDraftHint').textContent.includes(chrome.i18n.getMessage('msg_the_saved_list_has_changed_your_draft_has_not_36e48c20')), polling);
  assert.equal(await page.$eval('#customProxyText', input => input.value), 'HTTP draft.example.test:8123');
  assert.equal((await otherSave(savedRaw)).success, true);
  const submittedRaw = [savedRaw, 'HTTPS submitted-ui.test:443'].filter(Boolean).join('\n');
  await page.evaluate(raw => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.proxyAckFixture = { original };
    chrome.runtime.sendMessage = (message, callback) => original(message, response => {
      if (message.action === 'SAVE_MODS' && message.mods?.customProxyStringRaw === raw) {
        window.proxyAckFixture.release = () => callback(response);
      } else callback(response);
    });
    const input = document.getElementById('customProxyText');
    input.value = raw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('saveProxiesBtn').click();
  }, submittedRaw);
  await page.waitForFunction(() => typeof window.proxyAckFixture.release === 'function', polling);
  await page.$eval('#customProxyText', input => { input.value = 'HTTP draft.example.test:8123'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal((await otherSave(changedRaw)).success, true);
  await page.waitForFunction(() => document.getElementById('proxyDraftHint').textContent.includes(chrome.i18n.getMessage('msg_the_saved_list_has_changed_your_draft_has_not_36e48c20')), polling);
  await page.evaluate(() => window.proxyAckFixture.release());
  await page.waitForFunction(() => !document.getElementById('saveProxiesBtn').disabled, polling);
  assert.equal(await page.$eval('#customProxyText', input => input.value), 'HTTP draft.example.test:8123');
  assert.ok(await page.$eval('#proxyCardsList', list => list.textContent.includes('secondary-ui.test')), 'Old acknowledgement must not hide the newer saved list');
  assert.ok(await page.$eval('#proxyDraftHint', hint => hint.textContent.includes(chrome.i18n.getMessage('msg_the_saved_list_has_changed_your_draft_has_not_36e48c20'))));
  await page.evaluate(() => { chrome.runtime.sendMessage = window.proxyAckFixture.original; });
  assert.equal((await otherSave(savedRaw)).success, true);
  await otherView.close();
  await page.bringToFront();
  await page.$eval('#proxyEditorModeToggle', button => button.click());
  await page.$eval('#proxyAdvanced summary', summary => summary.focus());
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('#proxyAdvanced', details => details.open), true);
  const send = message => page.evaluate(payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve)), message);
  const before = (await send({ action: 'GET_STATE' })).data.pacMods.ifUseOwnProxiesOnlyForOwnSites;
  assert.equal((await send({ action: 'SAVE_MODS', mods: { ifUseOwnProxiesOnlyForOwnSites: true } })).success, true);
  await page.waitForFunction(() => document.getElementById('proxyAdvancedState').textContent.length > 0, polling);
  assert.equal(await page.$eval('#customProxyText', input => input.value), 'HTTP draft.example.test:8123', 'External updates must not overwrite a dirty proxy list');
  await page.$eval('#proxyAdvanced summary', summary => summary.click());
  assert.equal(await page.$eval('#proxyAdvanced', details => details.open), false);
  assert.ok(await page.$eval('#proxyAdvancedState', state => state.getBoundingClientRect().height > 0));
  assert.equal((await send({ action: 'SAVE_MODS', mods: { ifUseOwnProxiesOnlyForOwnSites: Boolean(before) } })).success, true);
  // Layout must reflow at small widths without clipping the endpoint inputs.
  await page.setViewport({ width: 420, height: 800, deviceScaleFactor: 1 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.evaluate(() => location.reload()),
  ]);
  await page.waitForFunction(() => document.querySelector('#tab-proxies.active') && document.getElementById('extVersion').textContent, polling);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.$eval('#proxyHost', input => input.getBoundingClientRect().width > 200), true);
  if (browserName === 'chrome') {
    await page.bringToFront();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await checkFits('proxies/light');
    await page.waitForFunction(() => {
      const probe = document.createElement('span');
      probe.style.background = 'var(--bg-surface)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(document.body).backgroundColor === expected &&
        getComputedStyle(document.querySelector('#tab-proxies .card')).backgroundColor === 'rgba(0, 0, 0, 0)';
    }, polling);
    await page.screenshot({ path: path.join(output, 'chrome-settings-proxies-light.png') });
  }
  console.log(`${browserName} settings layout passed: 900×600, compact fields, drafts, keyboard details, enabled-state hint, narrow reflow.`);
}
