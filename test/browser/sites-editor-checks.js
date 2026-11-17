// Run inside a real extension document in both Chrome and Firefox.
export async function checkSitesEditor() {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Sites editor timeout: ' + predicate.toString() +
        '\nstatus: ' + document.getElementById('saveStatusText')?.textContent +
        '\ntoast: ' + document.getElementById('toast')?.textContent +
        '\ndraft: ' + document.getElementById('newDomainInput')?.value);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const get = id => document.getElementById(id);
  const send = async message => {
    const rpc = payload => new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
    if (message.action === 'SAVE_MODS' && message.expectedRevision === undefined &&
        ['exceptions', 'whitelist'].some(key => Object.hasOwn(message.mods || {}, key))) {
      message = { ...message, expectedRevision: (await rpc({ action: 'GET_EXCEPTIONS' })).data.revision };
    }
    return rpc(message);
  };
  const snapshot = (await send({ action: 'GET_EXCEPTIONS' })).data;
  const select = target => document.querySelector(`[data-subtab="${target}"]`).click();
  const add = async (target, host) => {
    select(target);
    get('newDomainInput').value = host;
    get('addDomainBtn').click();
    await wait(() => get('saveStatusText').classList.contains('saved'));
  };
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  try {
    const tabCount = (await chrome.tabs.query({})).length;
    document.querySelector('[data-tab="exceptions"]').click();
    await wait(() => !get('manualRulesLink').disabled);
    get('manualRulesLink').click();
    await wait(() => get('newDomainInput').offsetHeight > 0);
    await wait(() => !get('newDomainInput').disabled);
    await add('included', 'editor-proxy.test');
    await add('excluded', 'editor-direct.test');
    await add('whitelist', 'editor-allow.test');
    const lists = (await send({ action: 'GET_EXCEPTIONS' })).data;
    assert(lists.exceptions['editor-proxy.test'] === true, 'Proxy add failed');
    assert(lists.exceptions['editor-direct.test'] === false, 'Direct add failed');
    assert(lists.whitelist.includes('editor-allow.test'), 'Allowlist add failed');
    select('included');
    get('searchDomainInput').value = 'editor-proxy';
    get('searchDomainInput').dispatchEvent(new Event('input'));
    assert(get('domainListContainer').querySelectorAll('.domain-card').length === 1, 'Search must filter cards');
    get('domainListContainer').querySelector('.delete-domain-btn').click();
    await wait(() => get('saveStatusText').classList.contains('saved'));
    assert((await send({ action: 'GET_EXCEPTIONS' })).data.exceptions['editor-proxy.test'] === undefined, 'Delete failed');
    get('searchDomainInput').value = '';
    get('searchDomainInput').dispatchEvent(new Event('input'));
    const transfer = new DataTransfer();
    transfer.items.add(new File(['imported-editor.test\nnot a domain\n'], 'domains.txt', { type: 'text/plain' }));
    get('fileImportInput').files = transfer.files;
    get('fileImportInput').dispatchEvent(new Event('change'));
    await wait(async () => (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions['imported-editor.test'] === true);
    await wait(() => get('saveStatusText').classList.contains('saved'));
    get('sourceFilter').value = 'import';
    get('sourceFilter').dispatchEvent(new Event('change'));
    assert(get('domainListContainer').textContent.includes('imported-editor.test'), 'Import source filter failed');
    let exported;
    const captureExport = event => {
      if (event.target.tagName === 'A' && event.target.download) {
        event.preventDefault();
        exported = fetch(event.target.href).then(response => response.text());
      }
    };
    document.addEventListener('click', captureExport, true);
    get('exportFileBtn').click();
    document.removeEventListener('click', captureExport, true);
    assert(exported && (await exported).includes('imported-editor.test'), 'Export must contain selected list');
    get('sourceFilter').value = '';
    get('sourceFilter').dispatchEvent(new Event('change'));
    get('modeToggleBtn').click();
    await wait(() => get('editorViewSection').style.display === 'block');
    const raw = 'raw-proxy.test\n===\nraw-direct.test\n===\nraw-allow.test';
    get('rawTextEditor').value = raw;
    // Simulate a failed write: navigation must preserve the draft and allow retry.
    chrome.runtime.sendMessage = (message, callback) => message.action === 'SAVE_MODS'
      ? callback({ success: false, error: 'Simulated save failure' }) : original(message, callback);
    get('rawTextEditor').dispatchEvent(new Event('input'));
    document.querySelector('[data-tab="pac"]').click();
    await wait(() => get('saveStatusText').classList.contains('error'));
    assert(document.querySelector('#tab-exceptions.active'), 'Failed draft must stay in Sites');
    assert(get('rawTextEditor').value === raw, 'Failed draft was lost');
    let releaseSave;
    let held = false;
    chrome.runtime.sendMessage = (message, callback) => original(message, response => {
      if (message.action === 'SAVE_MODS' && !held) {
        held = true;
        releaseSave = () => callback(response);
      } else callback(response);
    });
    document.querySelector('[data-tab="pac"]').click();
    await wait(() => releaseSave);
    const latestRaw = raw + '\nlatest-raw.test';
    get('rawTextEditor').value = latestRaw;
    get('rawTextEditor').dispatchEvent(new Event('input'));
    releaseSave();
    await wait(() => document.querySelector('#tab-pac.active'));
    chrome.runtime.sendMessage = original;
    const rawLists = (await send({ action: 'GET_EXCEPTIONS' })).data;
    assert(rawLists.exceptions['raw-proxy.test'] === true && rawLists.exceptions['raw-direct.test'] === false &&
      rawLists.whitelist.includes('raw-allow.test') && rawLists.whitelist.includes('latest-raw.test'),
    'Navigation must flush all text, including edits made while a previous save is acknowledged');
    document.querySelector('[data-tab="exceptions"]').click();
    await wait(() => !get('manualRulesLink').disabled);
    get('manualRulesLink').click();
    await wait(() => get('modeToggleBtn').offsetHeight > 0);
    get('modeToggleBtn').click();
    await wait(() => get('listViewSection').style.display === 'block');
    assert((await chrome.tabs.query({})).length === tabCount, 'Editor must stay in the same browser tab');
    const bulk = Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`chunk-${String(i).padStart(3, '0')}.test`, true]));
    await send({ action: 'SAVE_MODS', mods: { exceptions: bulk, whitelist: [] } });
    select('included');
    await wait(() => get('includedCount').textContent === '350');
    assert(get('domainListContainer').querySelectorAll('.domain-card').length === 100, 'Large lists must render in chunks');
    get('domainListContainer').scrollTop = get('domainListContainer').scrollHeight;
    get('domainListContainer').dispatchEvent(new Event('scroll'));
    assert(get('domainListContainer').querySelectorAll('.domain-card').length === 200, 'Scrolling must append the next chunk');
    assert(document.documentElement.scrollWidth <= innerWidth, 'Sites must fit the viewport width');
    return 'CRUD, search, source filter, file import/export, raw save/retry, same-tab navigation, chunked lists';
  } finally {
    chrome.runtime.sendMessage = original;
    await send({ action: 'SAVE_MODS', mods: { exceptions: snapshot.exceptions, whitelist: snapshot.whitelist } });
  }
}
