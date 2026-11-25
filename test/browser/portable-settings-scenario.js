import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendChromeMessage } from './chrome-rpc.js';

// Uses an installed extension, real browser downloads and a native file input.
// All credentials here are disposable local fixture values, never user data.
export async function verifyPortableSettings(browser, page, { primaryId, reserveId, password }) {
  const polling = { polling: 50, timeout: 20000 };
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unroute-portable-native-'));
  const send = message => sendChromeMessage(page, message);
  const ok = async message => {
    const response = await send(message);
    assert.equal(response?.success, true, `${message.action}: ${response?.error || 'failed'}`);
    return response.data;
  };
  const originalTheme = await page.$eval('#appearanceTheme', input => input.value);
  const originalNotifications = (await ok({ action: 'GET_STATE' })).notifications;
  let listId;
  let session;
  try {
    const revision = (await ok({ action: 'GET_EXCEPTIONS' })).revision;
    const list = await ok({ action: 'SAVE_DOMAIN_LIST', expectedRevision: revision,
      name: 'Portable fixture list', enabled: true, proxyId: primaryId,
      domains: ['portable-list.test', '*.portable-wild.test'] });
    listId = list.listId;
    await page.$eval('[data-tab="proxies"]', button => button.click());
    await page.select('#proxyFailoverSelect', reserveId);
    await page.waitForFunction(id => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_STATE' }, response =>
      resolve(response?.data?.pacMods?.fallbackProxyId === id))), polling, reserveId);
    await ok({ action: 'SET_NOTIFICATION_OPTION', key: 'pac-error', enabled: false });
    await page.$eval('[data-tab="appearance"]', button => button.click());
    await page.select('#appearanceTheme', 'dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', polling);
    await page.$eval('[data-tab="tools"]', button => button.click());
    assert.match(await page.$eval('#portable-warning', node => node.textContent), /JSON/);
    session = await browser.target().createCDPSession();
    await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    // The same live list must round-trip through native txt download/upload,
    // with its name used as the file name and a unique imported title.
    await page.$eval('[data-tab="exceptions"]', button => button.click());
    await page.waitForSelector(`[data-list-id="${listId}"] .domain-list-name`, { visible: true });
    await page.click(`[data-list-id="${listId}"] .domain-list-name`);
    const scoped = `[data-list-scope="${listId}"]`;
    await page.waitForSelector(`${scoped} button[id$="exportFileBtn"]:not(:disabled)`, { visible: true });
    await page.click(`${scoped} button[id$="exportFileBtn"]`);
    const textFile = path.join(directory, 'Portable fixture list.txt');
    const textDeadline = Date.now() + 20000;
    while (!fs.existsSync(textFile) && Date.now() < textDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(textFile), 'Named list must download using its actual title');
    const textDomains = ['portable-list.test', '*.portable-wild.test'].sort();
    assert.equal(fs.readFileSync(textFile, 'utf8'), textDomains.join('\n') + '\n');
    await page.click('#domainListsBack');
    await page.waitForSelector('#domainListImport:not(:disabled)', { visible: true });
    await page.click('#domainListImport');
    await (await page.$('#domainListFile')).uploadFile(textFile);
    await page.waitForFunction(() => !document.getElementById('domainListSave').disabled, polling);
    assert.equal(await page.$eval('#domainListName', input => input.value), 'Portable fixture list (2)');
    await page.click('#domainListSave');
    await page.waitForFunction(() => document.getElementById('domainListForm').hidden, polling);
    const listMetadata = await ok({ action: 'GET_DOMAIN_LISTS' });
    const importedList = listMetadata.lists.find(item => item.name === 'Portable fixture list (2)');
    assert.ok(importedList && importedList.id !== listId, 'Import creates a separate uniquely named list');
    assert.deepEqual((await ok({ action: 'GET_DOMAIN_LIST', listId: importedList.id })).list.domains, textDomains);
    await ok({ action: 'DELETE_DOMAIN_LIST', listId: importedList.id, expectedRevision: listMetadata.revision });
    fs.unlinkSync(textFile);
    await page.$eval('[data-tab="tools"]', button => button.click());
    console.log('Chrome named txt list: actual title-based filename, exact contents, native file import proposed a unique title and persisted a separate list.');
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('#portable-export');
    await page.waitForFunction(() => !document.getElementById('portable-export').disabled, polling);
    assert.deepEqual(fs.readdirSync(directory), [], 'Cancel must not export secrets');
    page.once('dialog', dialog => dialog.accept());
    await page.click('#portable-export');
    const filename = path.join(directory, 'unroute-settings.json');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(filename) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(filename), 'Confirmed export must produce a real downloaded JSON file');
    const backup = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(backup.format, 'unroute-settings');
    assert.equal(backup.includesPasswords, true);
    assert.ok(backup.settings.customProxyStringRaw.includes(encodeURIComponent(password)), 'Passwords must not be omitted or masked');
    assert.equal(backup.settings.fallbackProxyId, reserveId);
    assert.equal(backup.settings.domainLists.find(item => item.id === listId).domains.length, 2);
    assert.equal(backup.settings.domainProxyIds['edit-bound.test'], primaryId);
    assert.equal(backup.appearance.theme, 'dark');
    assert.equal(backup.notifications['pac-error'], false);

    const invalidFilename = path.join(directory, 'future-version.json');
    fs.writeFileSync(invalidFilename, JSON.stringify({ ...backup, formatVersion: backup.formatVersion + 1 }));
    page.once('dialog', dialog => dialog.accept());
    await (await page.$('#portable-file')).uploadFile(invalidFilename);
    await page.waitForFunction(() => document.getElementById('portable-status').textContent ===
      chrome.i18n.getMessage('portable_settings_failed'), polling);
    const unchanged = await ok({ action: 'EXPORT_SETTINGS' });
    assert.deepEqual(unchanged.settings, backup.settings, 'Invalid import must leave all stored settings unchanged');

    await ok({ action: 'RESET_SETTINGS' });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#portable-import:not(:disabled)'), polling);
    await page.$eval('[data-tab="tools"]', button => button.click());
    await page.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message?.action !== 'IMPORT_SETTINGS') return send(message, ...args);
        const callback = args.pop();
        return send(message, ...args, response => {
          window.portableImportResult = { success: response?.success, code: response?.errorCode,
            error: response?.error, saved: response?.data?.saved, pending: response?.data?.pending };
          callback?.(response);
        });
      };
    });
    page.once('dialog', dialog => dialog.accept());
    const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 });
    await (await page.$('#portable-file')).uploadFile(filename);
    try { await reloaded; }
    catch {
      const diagnostic = await page.evaluate(() => ({ result: window.portableImportResult,
        status: document.getElementById('portable-status')?.textContent }));
      throw new Error(`Native portable import did not reload: ${JSON.stringify(diagnostic)}`);
    }
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', polling);
    const restored = await ok({ action: 'EXPORT_SETTINGS' });
    const withoutRevisions = settings => Object.fromEntries(Object.entries(settings).filter(([key]) =>
      !['_revision', '_rulesRevision', '_proxyCatalogRevision'].includes(key)));
    assert.deepEqual(withoutRevisions(restored.settings), withoutRevisions(backup.settings), 'Full round trip must preserve rules, list contents, proxy identities, credentials and switches');
    assert.deepEqual(restored.appearance, backup.appearance);
    assert.deepEqual(restored.notifications, backup.notifications);
    assert.deepEqual(restored.pac, backup.pac);
    const state = await ok({ action: 'GET_STATE', includeExceptions: true });
    assert.equal(state.pacMods.fallbackProxyId, reserveId);
    assert.equal(state.pacMods.domainProxyIds['edit-bound.test'], primaryId);
    console.log('Chrome portable settings: confirmed real JSON download, cancel protection, full plaintext fixture credentials, invalid-version import unchanged, reset + native file import + page reload; complete settings/lists/passwords/notifications/theme/provider round trip.');
  } finally {
    try {
      if (listId && !page.isClosed()) {
        const snapshot = await send({ action: 'GET_EXCEPTIONS' });
        if (snapshot?.success) await send({ action: 'DELETE_DOMAIN_LIST', listId, expectedRevision: snapshot.data.revision });
      }
      if (!page.isClosed()) {
        for (const [key, enabled] of Object.entries(originalNotifications || {})) await send({ action: 'SET_NOTIFICATION_OPTION', key, enabled });
        await page.$eval('[data-tab="appearance"]', button => button.click());
        await page.select('#appearanceTheme', originalTheme);
      }
    } finally {
      if (session) await session.detach().catch(() => {});
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
