import assert from 'node:assert/strict';

// Deliberate RPC fault injection for UI recovery, not native routing/reload proof.
export async function verifyPopupRecovery(page) {
  const polling = { polling: 50, timeout: 15000 };
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.uiFixture = { routes: 0, hold: true, fail: false, original };
    chrome.runtime.sendMessage = (message, callback) => {
      if (message.action === 'SET_SITE_ROUTE') window.uiFixture.routes++;
      original(message, response => {
        if (message.action === 'GET_STATE' && window.uiFixture.hold) window.uiFixture.release = () => callback(response);
        else callback(message.action === 'GET_STATE' && window.uiFixture.fail ? { success: false, error: 'Test background unavailable' } : response);
      });
    };
    const select = document.getElementById('siteRoute');
    select.value = '@direct';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => typeof window.uiFixture.release === 'function', polling);
  assert.equal(await page.$$eval('#siteRoute', buttons => buttons.every(button => button.disabled)), true);
  await page.$eval('#siteRoute', select => { select.value = '@pac'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await page.evaluate(() => window.uiFixture.routes), 1, 'Do not accept a second action during state rehydration');
  await page.evaluate(() => { window.uiFixture.hold = false; window.uiFixture.release(); });
  await page.waitForFunction(() => !document.querySelector('#siteRoute').disabled, polling);
  await page.evaluate(() => { window.uiFixture.fail = true; document.getElementById('retryLoad').click(); });
  await page.waitForFunction(() => !document.getElementById('loadError').hidden, polling);
  assert.equal(await page.$eval('#reload', button => button.disabled), true);
  assert.equal(await page.$$eval('#siteRoute', buttons => buttons.every(button => button.disabled)), true);
  await page.evaluate(() => { window.uiFixture.fail = false; document.getElementById('retryLoad').click(); });
  await page.waitForFunction(() => document.getElementById('loadError').hidden && !document.getElementById('reload').disabled, polling);
  await page.evaluate(() => { chrome.runtime.sendMessage = window.uiFixture.original; });
  // Real reload/close is verified by the native popup fixture, never by
  // replacing tabs.reload or window.close in this fault-injection scenario.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('siteRoute').disabled, polling);
}
