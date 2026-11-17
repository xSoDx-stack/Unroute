import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyLocalization(browser, optionsPage, extensionId) {
  const expected = (process.env.UNROUTE_TEST_LOCALE || 'ru').startsWith('en') ? 'en' : 'ru';
  const state = await optionsPage.evaluate(() => ({
    language: chrome.i18n.getMessage('uiLanguage'), lang: document.documentElement.lang,
    title: document.title, sites: document.querySelector('[data-tab="exceptions"]').textContent.trim(),
    navigation: document.querySelector('nav').getAttribute('aria-label'),
    substitution: chrome.i18n.getMessage('msg_port_sub_is_outside_the_valid_range_1_65535_d383d658', ['70000']),
    manifestTitle: chrome.runtime.getManifest().action.default_title,
  }));
  assert.equal(state.language, expected);
  assert.equal(state.lang.split('-')[0], expected);
  assert.equal(state.title, expected === 'en' ? 'Unroute — Settings' : 'Unroute — Настройки');
  assert.equal(state.sites, expected === 'en' ? 'Sites' : 'Сайты');
  assert.equal(state.navigation, expected === 'en' ? 'Settings sections' : 'Разделы настроек');
  assert.equal(state.manifestTitle, expected === 'en' ? 'Unroute' : 'Unroute');
  assert.ok(state.substitution.includes('70000') && !state.substitution.includes('$'));
  if (expected === 'en') assert.ok(state.substitution.startsWith('Port '));
  const rejected = await optionsPage.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({
    action: 'SAVE_MODS', mods: { customProxyStringRaw: 'SOCKS5 user:pass@127.0.0.1:1080' },
  }, resolve)));
  assert.equal(rejected.success, false);
  assert.ok(rejected.error.includes(expected === 'en' ? 'Browser proxy APIs' : 'Прокси-API браузера'));
  const pageCount = (await browser.pages()).length;
  await optionsPage.$eval('[data-tab="exceptions"]', button => button.click());
  await optionsPage.waitForFunction(() => !document.getElementById('manualRulesLink').disabled);
    await optionsPage.click('#manualRulesLink');
  await optionsPage.waitForSelector('#manualSitesEditor #newDomainInput', { visible: true });
  await optionsPage.waitForFunction(() => !document.getElementById('newDomainInput').disabled);
  assert.equal((await browser.pages()).length, pageCount, 'Sites must open inside settings');
  assert.equal(await optionsPage.$eval('#tab-exceptions .sites-heading h1', node => node.textContent.trim()), expected === 'en' ? 'Sites' : 'Сайты');
  assert.equal(await optionsPage.$eval('#newDomainInput', node => node.placeholder), expected === 'en'
    ? 'Add a domain (e.g. rutracker.org or *.domain.com)' : 'Добавить домен (напр. rutracker.org или *.domain.com)');
  assert.equal(await optionsPage.$eval('#includedCount', node => node.textContent), '0');
  const site = await browser.newPage();
  let popup;
  try {
    await site.setRequestInterception(true);
    site.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Popup layout fixture</title>' }));
    await site.goto('https://layout.example.test/');
    popup = await browser.newPage();
    await popup.setViewport({ width: 360, height: 600, deviceScaleFactor: 1 });
    await popup.goto(`chrome-extension://${extensionId}/pages/popup/index.html`);
    await site.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => !document.getElementById('siteCard').hidden && document.getElementById('domain').textContent === 'example.test');
    await popup.bringToFront();
    const output = path.resolve('artifacts/ui-check');
    fs.mkdirSync(output, { recursive: true });
    await popup.screenshot({ path: path.join(output, `popup-spacing-${expected}.png`) });
    for (const count of [0, 300]) {
      const spacing = await popup.evaluate(value => {
        document.getElementById('resourceCount').textContent = value;
        const label = document.querySelector('#resourceDetails summary [data-i18n]').getBoundingClientRect();
        const counter = document.getElementById('resourceCount').getBoundingClientRect();
        const settings = document.querySelector('.settings > [data-i18n]').getBoundingClientRect();
        const arrow = document.querySelector('.settings-arrow').getBoundingClientRect();
        const button = document.querySelector('.settings').getBoundingClientRect();
        return { resourceGap: counter.left - label.right, row: Math.abs((counter.top + counter.bottom - label.top - label.bottom) / 2),
          settingsGap: arrow.left - settings.right, settingsLeft: settings.left,
          buttonLeft: button.left, arrowInset: button.right - arrow.right,
          overflow: document.documentElement.scrollWidth > innerWidth };
      }, count);
      assert.ok(spacing.resourceGap >= 8, `Resource count must follow its label with spacing: ${JSON.stringify(spacing)}`);
      assert.ok(spacing.row <= 3, 'Resource count and label must stay on one row');
      assert.ok(Math.abs(spacing.settingsGap - 6) <= 0.1 && spacing.settingsLeft - spacing.buttonLeft <= 12,
        `Settings text must start on the left, with the arrow on the right: ${JSON.stringify(spacing)}`);
      assert.ok(spacing.arrowInset >= 0 && spacing.arrowInset <= 12, 'Settings arrow must stay at the right edge of the button');
      assert.equal(spacing.overflow, false);
    }
  } finally {
    if (popup) await popup.close();
    await site.close();
    await optionsPage.bringToFront();
  }
  console.log(`Chrome native localization passed: ${expected}, settings, editor, accessibility, placeholders, and validation errors.`);
}
