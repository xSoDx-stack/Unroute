import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyAppearance(browser, page, extensionId, browserName = 'chrome') {
  const base = new URL('../../', page.url()).href;
  const polling = { polling: 50, timeout: 15000 };
  const read = key => page.evaluate(k => new Promise(resolve => chrome.storage.local.get(k, data => resolve(data[k]))), key);
  const original = await read('ui-appearance');
  const pacBefore = await read('pac-kitchen-mods');
  const output = path.resolve('artifacts/ui-check');
  fs.mkdirSync(output, { recursive: true });
  let popup;
  const iconPixels = p => p.$eval('.brand img, .brand-logo', image => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    canvas.getContext('2d').drawImage(image, 0, 0, 128, 128);
    return { pixels: canvas.toDataURL(), filter: getComputedStyle(image).filter };
  });
  const chooseTheme = async theme => {
    await page.select('#appearanceTheme', theme);
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, polling, theme);
  };
  try {
    console.log(`${browserName} appearance: open settings`);
    await page.goto(new URL('pages/options/index.html#appearance', base).href);
    await page.reload(); // A fragment-only navigation does not rerun the options bootstrap.
    await page.waitForSelector('#appearanceTheme');
    await page.waitForFunction(() => document.querySelector('#tab-appearance.active'), polling);
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    const fixedIcon = await iconPixels(page);
    console.log(`${browserName} appearance: fixed icon loaded`);
    await chooseTheme('dark');
    popup = await browser.newPage();
    await popup.goto(new URL('pages/popup/index.html', base).href);
    await popup.waitForFunction(() => document.documentElement.dataset.theme === 'dark', polling);
    await page.bringToFront(); // CDP pointer events need a foreground extension document.
    for (const theme of ['dark', 'light']) {
      await chooseTheme(theme);
      console.log(`${browserName} appearance: ${theme} palette synchronization`);
      await popup.waitForFunction(value => document.documentElement.dataset.theme === value, polling, theme);
      for (const accent of ['mint', 'blue', 'sage']) {
        await page.click(`[data-accent="${accent}"]`);
        await page.waitForFunction(value => new Promise(resolve => chrome.storage.local.get('ui-appearance', data => resolve(data['ui-appearance']?.accent === value))), polling, accent);
        const expected = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-primary'));
        await popup.waitForFunction(value => getComputedStyle(document.documentElement).getPropertyValue('--accent-primary') === value, polling, expected);
        assert.deepEqual(await iconPixels(page), fixedIcon, 'Palette must not recolor the brand image');
        assert.deepEqual(await iconPixels(popup), fixedIcon, 'Popup and settings must use the same brand image');
      }
      for (const custom of ['#000000', '#ffffff', '#ff00ff']) {
        await page.$eval('#appearanceHex', (input, value) => {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, custom);
        await page.waitForFunction(value => new Promise(resolve => chrome.storage.local.get('ui-appearance', data => {
          const appearance = data['ui-appearance'];
          resolve(appearance?.accent === 'custom' && appearance.customColor === value);
        })), polling, custom);
        const ratios = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          const luminance = name => {
            const rgb = style.getPropertyValue(name).trim().slice(1).match(/../g)
              .map(channel => parseInt(channel, 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
            return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
          };
          const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          return [ratio(luminance('--on-accent'), luminance('--accent-primary')),
            ratio(luminance('--accent-text'), luminance('--bg-surface'))];
        });
        assert.ok(ratios.every(ratio => ratio >= 4.5), `${theme}/${custom}: actual computed contrast`);
        assert.deepEqual(await iconPixels(page), fixedIcon);
      }
      await page.$eval('#appearanceHex', input => { input.value = '#not-a-color'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.equal(await page.$eval('#appearanceHex', input => input.getAttribute('aria-invalid')), 'true');
      assert.equal((await read('ui-appearance')).customColor, '#ff00ff', 'Invalid input must not overwrite the saved color');
      await page.click('[data-accent="mint"]');
      await page.waitForFunction(() => document.querySelector('.appearance-status')?.dataset.state === 'saved', polling);
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      await page.screenshot({ path: path.join(output, `${browserName}-appearance-${theme}.png`) });
    }
    await page.reload();
    console.log(`${browserName} appearance: persisted theme reload`);
    await page.waitForFunction(() => document.querySelector('#tab-appearance.active') && document.getElementById('appearanceTheme')?.value === 'light', polling);
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', polling);
    // A manual theme must take priority over the operating system.
    if (browserName === 'chrome') {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      assert.equal(await page.$eval('html', el => el.dataset.theme), 'light');
      await page.select('#appearanceTheme', 'system');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', polling);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', polling);
    }
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 1 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(await read('pac-kitchen-mods'), pacBefore, 'Appearance changes must not modify PAC rules/settings');
    console.log(`${browserName} appearance passed: palette persistence, cross-view sync, fixed logo, light/dark, 360px reflow, no PAC writes (${extensionId}).`);
  } catch (error) {
    console.error('Appearance check failed before cleanup:', error);
    throw error;
  } finally {
    if (popup) await popup.close();
    await page.evaluate(value => new Promise(resolve => {
      if (value === undefined) chrome.storage.local.remove('ui-appearance', resolve);
      else chrome.storage.local.set({ 'ui-appearance': value }, resolve);
    }), original);
    if (browserName === 'chrome') await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await page.goto(new URL('pages/options/index.html', base).href);
  }
}
