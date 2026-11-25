// Focused source-DOM checks only: RPC boundary is controlled here; no extension build.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const read = name => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const source = name => read(`src/common/${name}`).replace(/^import .*;\r?\n/gm, '').replace(/^export \{[^}]*\} from .*;\r?\n/gm, '').replace(/^export /gm, '');
const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
assert.ok(executablePath, 'Set CHROME_PATH to run focused DOM checks');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1100, height: 1000 });
  const html = read('src/common/pages/options/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link[^>]*>/gi, '');
  await page.setContent(html);
  await page.addStyleTag({ content: read('src/common/pages/shared/theme.css') + read('src/common/pages/options/style.css').replace(/^@import.*$/gm, '') + read('src/common/pages/options/sites-editor.css') });
  await page.addScriptTag({ content: `
    const t = (_key, fallback, substitutions = []) => substitutions.reduce((text, value, i) => text.replaceAll('$' + (i + 1), value), fallback);
    const uiLocale = () => 'ru';
    const ruleSourceLabel = () => 'Вручную';
    const messages = [];
    const notices = [];
    let failure = null;
    let snapshot = { revision: 4, exceptions: Object.fromEntries(Array.from({length:350}, (_,i) => ['domain-' + String(i).padStart(3,'0') + '.test',true])), whitelist: [], ruleMeta: {}, domainProxyIds: {}, defaultProxyId: 'custom:a', proxyCatalog: [
      {id:'custom:a',name:'Alpha',endpoint:'HTTP 127.0.0.1:8080',enabled:true,builtin:false},
      {id:'custom:b',name:'Beta',endpoint:'HTTPS proxy.test:443',enabled:true,builtin:false},
      {id:'builtin:tor',name:'Tor',endpoint:'SOCKS5 127.0.0.1:9150',enabled:false,builtin:true}
    ]};
    async function sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.action === 'GET_EXCEPTIONS') {
        if (message.knownRevision === snapshot.revision) return {success:true,data:{unchanged:true,revision:snapshot.revision,proxyCatalog:snapshot.proxyCatalog,defaultProxyId:snapshot.defaultProxyId}};
        return {success:true,data:structuredClone(snapshot)};
      }
      if (failure) return {success:false,error:failure};
      if (message.expectedRevision !== snapshot.revision) return {success:false,error:{code:'RULES_CONFLICT',message:'Conflict'}};
      if (message.action === 'MUTATE_DOMAIN_RULES') for (const op of message.operations) {
        if (op.mode === 'proxy') { snapshot.exceptions[op.domain] = true; if(op.proxyId) snapshot.domainProxyIds[op.domain] = op.proxyId; }
        if (op.mode === 'direct') { snapshot.exceptions[op.domain] = false; delete snapshot.domainProxyIds[op.domain]; }
        if (op.mode === 'pac') { delete snapshot.exceptions[op.domain]; delete snapshot.domainProxyIds[op.domain]; }
        if (op.mode === 'whitelist-add') snapshot.whitelist.push(op.domain);
        if (op.mode === 'whitelist-remove') snapshot.whitelist = snapshot.whitelist.filter(d => d !== op.domain);
      }
      if (message.action === 'ASSIGN_DOMAIN_PROXIES') for (const d of message.domains) snapshot.domainProxyIds[d] = message.proxyId;
      if (message.action === 'IMPORT_EXCEPTIONS_BATCH') {
        let added = 0;
        let unchanged = 0;
        for (const d of message.domains) {
          if (snapshot.exceptions[d] === true) { unchanged++; continue; }
          snapshot.exceptions[d] = true;
          if(message.proxyId) snapshot.domainProxyIds[d] = message.proxyId;
          added++;
        }
        snapshot.revision++;
        return {success:true,data:{rulesRevision:snapshot.revision,added,changed:0,unchanged}};
      }
      if (message.action === 'SAVE_MODS') { snapshot.exceptions = message.mods.exceptions; snapshot.whitelist = message.mods.whitelist; }
      snapshot.revision++;
      return {success:true,data:{rulesRevision:snapshot.revision,added:1,changed:0,unchanged:0}};
    }
    ${source('core/domain-rules.js')}
    ${source('core/domain-lists.js')}
    ${source('pages/options/settings-help.js')}
    ${source('pages/options/domain-cards-list.js')}
    ${source('pages/options/domain-file-io.js')}
    ${source('pages/options/domain-lists-editor.js')}
    ${source('pages/options/sites-editor.js')}
    const editor = initDomainEditor(document.getElementById('manualSitesEditor'), {notify:text=>notices.push(text),onApplicationState:()=>{},navigate:()=>{}});
    document.getElementById('tab-exceptions').classList.add('active');
    window.testUI = { editor, messages, notices, snapshot, fail:value=>{failure=value;} };
  ` });
  await page.evaluate(() => window.testUI.editor.activate());
  assert.equal(await page.$eval('#domainListContainer', e => e.children.length), 100);
  assert.equal(await page.$eval('#newRuleProxyRow', e => e.hidden), false);
  await page.click('#selectAllFiltered');
  assert.match(await page.$eval('#selectionCount', e => e.textContent), /350/);
  await page.select('#bulkProxy', 'custom:b');
  await page.evaluate(() => window.testUI.fail({code:'RULES_CONFLICT',message:'Conflict'}));
  await page.click('#bulkAssign');
  await page.waitForFunction(() => document.getElementById('saveStatusText').classList.contains('error'));
  assert.match(await page.$eval('#selectionCount', e => e.textContent), /Выбрано: 350/, 'failed bulk assignment must retain selection');
  await page.evaluate(() => window.testUI.fail(null));
  await page.click('#bulkAssign');
  await page.waitForFunction(() => !document.getElementById('bulkAssign').disabled || document.getElementById('selectionCount').textContent.includes('Выбрано: 0'));
  let assignment = await page.evaluate(() => window.testUI.messages.find(m => m.action === 'ASSIGN_DOMAIN_PROXIES'));
  assert.equal(assignment.domains.length, 350, 'select-all must include unloaded chunks');
  assert.equal(assignment.expectedRevision, 4);
  await page.evaluate(() => { window.testUI.snapshot.proxyCatalog[1].name = 'Renamed'; return window.testUI.editor.refresh(); });
  assert.equal(await page.$eval('.domain-proxy-select', e => e.selectedOptions[0].textContent), 'Renamed');
  await page.click('[data-subtab="excluded"]');
  assert.equal(await page.$('.domain-proxy-select'), null);
  assert.equal(await page.$eval('#selectionToolbar', e => e.hidden), true);
  await page.click('[data-subtab="included"]');
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['import-a.test\nimport-b.test\ndomain-001.test\n'], 'domains.txt', {type:'text/plain'}));
    document.getElementById('fileImportInput').files = transfer.files;
    document.getElementById('fileImportInput').dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => window.testUI.notices.some(text => text.includes('Добавлено: 2')));
  const imported = await page.evaluate(() => window.testUI.messages.find(m => m.action === 'IMPORT_EXCEPTIONS_BATCH'));
  assert.equal(imported.reassignExisting, false);
  assert.equal(imported.proxyId, 'custom:a');
  assert.equal(await page.evaluate(() => window.testUI.snapshot.domainProxyIds['domain-001.test']), 'custom:b');
  assert.equal(await page.evaluate(() => window.testUI.snapshot.domainProxyIds['import-a.test']), 'custom:a');
  assert.match(await page.evaluate(() => window.testUI.notices.at(-1)), /без изменений: 1/);
  await page.click('.domain-select[data-domain="domain-001.test"]');
  await page.click('#bulkWildcardBtn');
  await page.waitForFunction(() => window.testUI.snapshot.exceptions['*.domain-001.test'] === true);
  assert.equal(await page.evaluate(() => window.testUI.snapshot.exceptions['domain-001.test']), undefined);
  assert.equal(await page.evaluate(() => window.testUI.snapshot.domainProxyIds['*.domain-001.test']), 'custom:b', 'wildcard toggle must preserve assigned proxy');
  assert.equal(await page.$eval('.domain-select[data-domain="*.domain-001.test"]', e => e.checked), true, 'toggled domain stays selected');
  await page.click('#bulkWildcardBtn');
  await page.waitForFunction(() => window.testUI.snapshot.exceptions['domain-001.test'] === true);
  assert.equal(await page.evaluate(() => window.testUI.snapshot.domainProxyIds['domain-001.test']), 'custom:b');
  await page.click('#clearSelection');
  assert.equal(await page.evaluate(() => window.testUI.messages.some(m => m.action === 'SAVE_MODS')), false, 'normal edits must never replace a rule snapshot');
  await page.setViewport({ width: 360, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'assignment controls must fit 360px');
  await page.setViewport({ width: 1100, height: 1000 });
  await page.click('#modeToggleBtn');
  await page.waitForFunction(() => document.getElementById('editorViewSection').style.display === 'block');
  await page.evaluate(() => {
    window.testUI.fail('Temporary save failure');
    document.getElementById('rawTextEditor').value = 'draft.test\n===\ndirect.test\n===\nallow.test';
    document.getElementById('rawTextEditor').dispatchEvent(new Event('input'));
  });
  assert.equal(await page.evaluate(() => window.testUI.editor.flush()), false);
  await page.evaluate(() => window.testUI.fail(null));
  assert.equal(await page.evaluate(() => window.testUI.editor.flush()), true, 'ordinary failures must retry without discarding the draft');
  await page.evaluate(() => {
    window.testUI.fail({code:'RULES_CONFLICT',message:'Conflict'});
    document.getElementById('rawTextEditor').value = 'conflict-draft.test\n===\n\n===\n';
    document.getElementById('rawTextEditor').dispatchEvent(new Event('input'));
  });
  assert.equal(await page.evaluate(() => window.testUI.editor.flush()), false);
  assert.match(await page.$eval('#rawTextEditor', e => e.value), /conflict-draft/);
  await page.evaluate(() => { window.testUI.fail(null); window.testUI.snapshot.revision++; });
  await page.click('#rawRetrySave');
  await page.waitForFunction(() => document.getElementById('rawRetrySave').hidden);
  assert.equal(await page.evaluate(() => window.testUI.snapshot.exceptions['conflict-draft.test']), true);
  await page.evaluate(() => {
    const editor = document.getElementById('rawTextEditor');
    editor.focus();
    editor.setSelectionRange(0, 'conflict-draft.test'.length);
  });
  await page.click('#rawWildcardBtn');
  assert.match(await page.$eval('#rawTextEditor', e => e.value), /^\*\.conflict-draft\.test/m);
  assert.equal(await page.evaluate(() => window.testUI.editor.flush()), true);
  assert.equal(await page.evaluate(() => window.testUI.snapshot.exceptions['*.conflict-draft.test']), true);
  const geometry = await page.evaluate(() => ({ sidebar: getComputedStyle(document.querySelector('body > .nav-tabs')).width, header: getComputedStyle(document.querySelector('.app-header')).height, columns: getComputedStyle(document.body).gridTemplateColumns }));
  assert.equal(geometry.header, '54px');
  assert.equal(geometry.sidebar, '164px');
  assert.equal(errors.length, 0, errors.join('\n'));
  const proxiesPage = await browser.newPage();
  proxiesPage.on('pageerror', error => errors.push(error.message));
  await proxiesPage.setContent(html);
  await proxiesPage.addScriptTag({ content: `
    const t = (_key, fallback, substitutions = []) => substitutions.reduce((text, value, i) => text.replaceAll('$' + (i + 1), value), fallback);
    const uiLocale = () => 'ru';
    const localizeDocument = () => {};
    const initAppearance = () => {};
    const renderApplicationBanner = () => {};
    const calls = [];
    const profiles = [{id:'custom:a',name:'Alpha',endpoint:'PROXY 127.0.0.1:8080'}, {id:'custom:b',name:'Beta',endpoint:'HTTPS proxy.test:443'}];
    let defaultId = 'custom:a';
    let failed = false;
    let holdUpdate = false, releaseUpdate = null;
    const chrome = {tabs:{query:async()=>[]}};
    const requestBackground = async message => {
      calls.push(structuredClone(message));
      if (message.action === 'UPDATE_PROXY_PROFILE') {
        if (holdUpdate) await new Promise(resolve => { releaseUpdate = resolve; });
        if(failed) return {success:false,error:{code:'DUPLICATE_NAME',message:'Duplicate name'}};
        profiles.find(p=>p.id === message.proxyId).name = message.name;
      }
      if (message.action === 'SET_DEFAULT_PROXY') defaultId = message.proxyId;
      if (message.action === 'DELETE_PROXY_PROFILE') profiles.splice(profiles.findIndex(p=>p.id === message.proxyId),1);
      if (message.action === 'GET_EXCEPTIONS') return {success:true,data:{proxyCatalog:[...profiles.map(p=>({...p,enabled:true,builtin:false})),{id:'builtin:tor',name:'Tor',endpoint:'SOCKS5 127.0.0.1:9150',enabled:true,builtin:true}],defaultProxyId:defaultId}};
      return {success:true,data:{pacMods:{proxyProfiles:profiles,defaultProxyId:defaultId,ifUseLocalTor:true,customProxyStringRaw: profiles.map(p=>p.id === 'custom:a'?'HTTP user:secret@127.0.0.1:8080':p.endpoint).join(';')},syncState:{providers:{}},proxyHealthMap:{}}};
    };
    ${source('core/web-host.js')}
    ${source('core/utils.js')}
    ${source('core/proxy-profiles.js')}
    ${source('pages/options/proxy-connection-editor.js')}
    ${source('pages/options/proxy-card-health.js')}
    ${source('pages/options/settings-help.js')}
    ${source('pages/options/proxies-panel.js')}
    ${source('pages/options/pac-panel.js')}
    ${source('pages/options/preferences-panel.js')}
    ${source('pages/options/diagnostics-panel.js')}
    ${source('pages/options/navigation.js')}
    ${source('pages/options/history-panel.js')}
    ${source('pages/options/options-state.js')}
    ${source('pages/options/app.js').split("if (document.readyState === 'loading')")[0]}
    initElements();
    sitesEditor = { refresh:()=>{} };
    proxiesPanel = createProxiesPanel();
    pacPanel = createPacPanel();
    preferencesPanel = createPreferencesPanel();
    window.proxyUI = { load:()=>refreshState(), calls, setup:setupEvents, fail:value=>{failed=value;},
      hold:()=>{holdUpdate=true;}, isHeld:()=>Boolean(releaseUpdate), release:()=>{holdUpdate=false;releaseUpdate?.();releaseUpdate=null;} };
  ` });
  await proxiesPage.evaluate(() => window.proxyUI.load());
  assert.equal(await proxiesPage.$eval('#defaultProxySelect', e => [...e.options].some(o => o.value === 'builtin:tor')), true, 'catalog fallback must use the real RPC for built-in targets');
  assert.equal(await proxiesPage.$eval('#proxyCardsList', e => e.textContent.includes('secret')), false);
  await proxiesPage.evaluate(() => window.proxyUI.setup());
  assert.equal(await proxiesPage.$$eval('.rename-proxy-btn', nodes => nodes.length), 0, 'name changes use the pencil, not a duplicate action');
  assert.equal(await proxiesPage.$$eval('.edit-proxy-btn', nodes => nodes.length), 2, 'one pencil per custom proxy');
  await proxiesPage.click('.edit-proxy-btn');
  assert.equal(await proxiesPage.$eval('.proxy-item .proxy-actions', node => node.hidden), true, 'editing hides refresh, edit and delete for the active proxy');
  assert.equal(await proxiesPage.$eval('.proxy-item:nth-child(2) .proxy-actions', node => node.hidden), false, 'other proxies remain available');
  await proxiesPage.evaluate(() => window.proxyUI.load());
  assert.equal(await proxiesPage.$eval('.proxy-item .proxy-actions', node => node.hidden), true, 'background refresh cannot restore actions during editing');
  await proxiesPage.click('.proxy-editor-actions [type=button]');
  assert.equal(await proxiesPage.$eval('.proxy-item .proxy-actions', node => node.hidden), false, 'cancel restores the row actions');
  await proxiesPage.click('.edit-proxy-btn');
  await proxiesPage.$eval('.proxy-profile-editor input', e => { e.value = 'x'.repeat(33); e.dispatchEvent(new Event('input')); });
  assert.equal(await proxiesPage.$eval('.proxy-profile-editor input', e => e.checkValidity()), false, 'rename must reject a 33-character name before RPC');
  await proxiesPage.click('.proxy-profile-editor button');
  assert.equal(await proxiesPage.evaluate(() => window.proxyUI.calls.some(call => call.action === 'UPDATE_PROXY_PROFILE')), false);
  await proxiesPage.$eval('#proxyName', e => { e.value = 'x'.repeat(33); e.dispatchEvent(new Event('input')); });
  assert.equal(await proxiesPage.$eval('#proxyName', e => e.checkValidity()), false, 'the add form uses the same name limit');
  await proxiesPage.$eval('#proxyName', e => { e.value = '😀'.repeat(32); e.dispatchEvent(new Event('input')); });
  assert.equal(await proxiesPage.$eval('#proxyName', e => e.checkValidity()), true, '32 astral code points are valid despite 64 UTF-16 code units');
  await proxiesPage.$eval('.proxy-profile-editor input', e => { e.value = 'Work'; e.dispatchEvent(new Event('input')); });
  await proxiesPage.evaluate(() => window.proxyUI.fail(true));
  await proxiesPage.click('.proxy-profile-editor button');
  await proxiesPage.waitForFunction(() => document.querySelector('.proxy-connection-error')?.textContent.includes('Duplicate name'));
  assert.equal(await proxiesPage.$eval('.proxy-profile-editor input', e => e.value), 'Work', 'failed rename must retain its draft');
  assert.equal(await proxiesPage.$eval('.proxy-item .proxy-actions', node => node.hidden), true, 'a rejected save keeps the editor and its actions hidden');
  await proxiesPage.evaluate(() => window.proxyUI.fail(false));
  await proxiesPage.evaluate(() => window.proxyUI.hold());
  await proxiesPage.click('.proxy-profile-editor button');
  await proxiesPage.waitForFunction(() => window.proxyUI.isHeld());
  assert.equal(await proxiesPage.$eval('.proxy-item .proxy-actions', node => node.hidden), true, 'pending saves keep row actions hidden');
  assert.equal(await proxiesPage.$eval('.proxy-connection-editor', node => node.disabled), true);
  await proxiesPage.evaluate(() => window.proxyUI.release());
  await proxiesPage.waitForFunction(() => document.querySelector('.proxy-profile-name').textContent === 'Work');
  assert.equal(await proxiesPage.$eval('.proxy-item .proxy-actions', node => node.hidden), false, 'a successful save restores the row actions');
  await proxiesPage.select('#defaultProxySelect', 'custom:b');
  await proxiesPage.waitForFunction(() => window.proxyUI.calls.some(m => m.action === 'SET_DEFAULT_PROXY'));
  await proxiesPage.click('.delete-btn');
  await proxiesPage.click('.proxy-profile-editor button');
  assert.equal(await proxiesPage.evaluate(() => window.proxyUI.calls.some(m => m.action === 'DELETE_PROXY_PROFILE')), false, 'deletion must not guess a replacement');
  await proxiesPage.select('.proxy-profile-editor select', 'custom:b');
  await proxiesPage.click('.proxy-profile-editor button');
  await proxiesPage.waitForFunction(() => document.querySelectorAll('.proxy-profile-name').length === 1 && !document.querySelector('.proxy-profile-editor'));
  assert.deepEqual(await proxiesPage.evaluate(() => window.proxyUI.calls.find(m => m.action === 'DELETE_PROXY_PROFILE')), {action:'DELETE_PROXY_PROFILE',proxyId:'custom:a',replacementProxyId:'custom:b'});
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: profile rename/default/delete RPCs, explicit replacement, auth-free display, catalog fallback');
  console.log('PASS: 350-row bulk scope, catalog-only rename, direct controls, raw save/retry/conflict, design01 geometry');
} finally { await browser.close(); }
