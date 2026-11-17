// Shared native-extension DOM + RPC scenario. Only the network probe is supplied
// by each isolated browser harness; routing and all writes remain production code.
export async function checkDomainListsNative({ proxyPort, secondProxyPort, probe, pacExpected = 'origin-direct' }) {
  probe ||= window.probeDomainListsNative;
  const assert = (value, label) => { if (!value) throw new Error('Domain lists: ' + label); };
  const request = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
  const ok = async message => {
    const response = await request(message);
    assert(response?.success, message.action + ': ' + JSON.stringify(response));
    return response.data;
  };
  const wait = async predicate => {
    const end = Date.now() + 20000;
    while (!await predicate()) {
      if (Date.now() > end) {
        window.domainListsFailureState = await new Promise(resolve => chrome.storage.local.get('pac-kitchen-mods', resolve));
        const rows = [...document.querySelectorAll('.domain-list-row')].map(row => ({ id: row.dataset.listId,
          controls: [...row.querySelectorAll('button,input,select')].map(control => ({ tag: control.tagName, text: control.textContent,
            disabled: control.disabled, boundary: control.dataset.boundary })) }));
        throw new Error('Domain lists timeout: ' + predicate.toString() + '; status=' + document.getElementById('domainListsStatus')?.textContent + '; toast=' + document.getElementById('toast')?.textContent + '; rows=' + JSON.stringify(rows));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const get = id => document.getElementById(id);
  const read = () => ok({ action: 'GET_DOMAIN_LISTS' });
  const list = async id => (await ok({ action: 'GET_DOMAIN_LIST', listId: id })).list;
  const write = async message => ok({ ...message, expectedRevision: (await read()).revision });
  const saved = (await ok({ action: 'GET_STATE', includeExceptions: true })).pacMods;
  const ids = [];
  const proofs = [];
  const networkErrors = [];
  window.domainListsNativeProofs = proofs;
  const network = async (host, expected, label, resource = false, route = null) => {
    const result = await probe(host, label, resource, route);
    if (result !== expected) networkErrors.push(`${label}: ${result} !== ${expected}`);
    proofs.push({ host, label, expected, actual: result, resource });
  };
  const ready = () => !get('domainListAdd').disabled;
  const row = id => document.querySelector(`.domain-list-row[data-list-id="${id}"]`);
  try {
    await ok({ action: 'SAVE_MODS', mods: { customProxyStringRaw: `HTTP 127.0.0.1:${proxyPort}\nHTTP 127.0.0.1:${secondProxyPort}`,
      ifUseSecureProxiesOnly: false, ifMindExceptions: true, ifMindWhitelist: false, ifProxyHttpsUrlsOnly: false,
      ifUseLocalTor: false, ifUseLocalWarp: false, ifUseOwnProxiesOnlyForOwnSites: true,
      exceptions: {}, whitelist: [], pacBypassDomains: [] }, expectedRevision: (await read()).revision });
    const catalog = (await read()).proxyCatalog;
    const a = catalog.find(item => item.endpoint === `PROXY 127.0.0.1:${proxyPort}`).id;
    const b = catalog.find(item => item.endpoint === `PROXY 127.0.0.1:${secondProxyPort}`).id;
    // Fixture RPC writes may precede the overview's asynchronous activation read.
    // Wait for that real render before capturing an import form's revision.
    let rendered = false;
    const observer = new MutationObserver(() => { rendered = true; });
    observer.observe(get('domainListsRows'), { childList: true });
    document.querySelector('[data-tab="exceptions"]').click();
    try { await wait(() => rendered && !get('domainListsOverview').hidden && ready()); }
    finally { observer.disconnect(); }
    const importList = async (name, proxyId, text) => {
      await wait(ready);
      get('domainListImport').click();
      get('domainListName').value = name;
      get('domainListProxy').value = proxyId;
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], 'native-domains.txt', { type: 'text/plain' }));
      get('domainListFile').files = transfer.files;
      get('domainListFile').dispatchEvent(new Event('change'));
      await wait(() => !get('domainListSave').disabled);
      get('domainListSave').click();
      await wait(() => get('domainListForm').hidden && ready());
      const created = (await read()).lists.find(item => item.name === name);
      assert(created && /^list:[0-9a-f-]{36}$/.test(created.id), 'stable list UUID');
      ids.push(created.id);
      return created.id;
    };
    const first = await importList('Native first', a, '*.native-list-a.test\nshared.native-list-a.test\n');
    const second = await importList('Native second', b, 'shared.native-list-a.test\nwild.native-list-a.test\nnative-list-b.test\n');
    assert((await list(first)).domains.includes('shared.native-list-a.test') &&
      (await list(second)).domains.includes('shared.native-list-a.test'), 'duplicates across lists retained');
    await network('wild.native-list-a.test', 'own-proxy', 'first-wildcard-over-lower-exact');
    await network('native-list-b.test', 'second-proxy', 'independent-second');
    row(first).querySelector('[data-open]').click();
    await wait(() => document.querySelector('[data-list-scope]:not([hidden]) input[id$="newDomainInput"]:not(:disabled)'));
    const scope = document.querySelector('[data-list-scope]:not([hidden])');
    scope.querySelector('input[id$="newDomainInput"]').value = 'scoped-only.example.test';
    scope.querySelector('button[id$="addDomainBtn"]').click();
    await wait(async () => (await list(first)).domains.includes('scoped-only.example.test'));
    assert(!(await list(second)).domains.includes('scoped-only.example.test'), 'scoped editor never edits other list');
    assert(!Object.hasOwn((await ok({ action: 'GET_EXCEPTIONS' })).exceptions, 'scoped-only.example.test'), 'scoped edit never creates manual rule');
    get('domainListsBack').click(); await wait(() => !get('domainListsOverview').hidden && ready());
    row(first).querySelector('input[type="checkbox"]').click();
    await wait(async () => !(await list(first)).enabled && ready());
    await network('shared.native-list-a.test', 'second-proxy', 'disabled-first-skipped');
    row(first).querySelector('input[type="checkbox"]').click();
    await wait(async () => (await list(first)).enabled && ready());
    row(second).querySelector('.domain-list-actions button').click();
    await wait(async () => (await read()).lists[0].id === second && ready());
    // Exercise the installed drag controller with real storage/RPC on both
    // runtimes. Physical mouse/capture is separately covered by source Puppeteer.
    // app.js debounces the previous write's background refresh by 50 ms.
    // Let that lifecycle boundary finish before holding a new drag open across
    // an asynchronous RPC; cancellation on external refresh is tested separately.
    await new Promise(resolve => setTimeout(resolve, 150));
    const handle = row(second).querySelector('.domain-list-handle');
    assert(handle && !handle.disabled, 'dedicated drag handle is available');
    const start = handle.getBoundingClientRect(), target = row(first).getBoundingClientRect();
    const point = { pointerId: 71, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: start.left + start.width / 2, clientY: start.top + start.height / 2, bubbles: true, cancelable: true };
    handle.dispatchEvent(new PointerEvent('pointerdown', point));
    document.dispatchEvent(new PointerEvent('pointermove', { ...point, clientY: target.bottom - 3 }));
    assert(get('domainListsRows').querySelector('.domain-list-row').dataset.listId === first, 'drag previews the new order');
    assert((await read()).lists[0].id === second, 'drag preview must not persist before release');
    document.dispatchEvent(new PointerEvent('pointerup', { ...point, buttons: 0, clientY: target.bottom - 3 }));
    await wait(async () => (await read()).lists[0].id === first && ready());
    const keyboardHandle = row(second).querySelector('.domain-list-handle');
    keyboardHandle.focus();
    keyboardHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
    await wait(async () => (await read()).lists[0].id === second && ready());
    assert(document.activeElement === row(second).querySelector('.domain-list-handle'), 'keyboard focus restored after confirmed reorder');
    await network('shared.native-list-a.test', 'second-proxy', 'reorder-changes-priority');
    const staleRevision = (await read()).revision;
    await write({ action: 'SAVE_DOMAIN_LIST', listId: first, name: 'Native first renamed' });
    assert((await list(first)).name === 'Native first renamed', 'rename readback');
    const stale = await request({ action: 'SAVE_DOMAIN_LIST', listId: second, domains: [], expectedRevision: staleRevision });
    assert(stale.success === false && (await list(second)).domains.length === 3, 'stale revision rejected atomically');
    await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'shared.native-list-a.test', mode: 'proxy', proxyId: a }], expectedRevision: (await read()).revision });
    await network('shared.native-list-a.test', 'own-proxy', 'manual-rule-over-list');
    await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'shared.native-list-a.test', mode: 'pac' }], expectedRevision: (await read()).revision });
    await ok({ action: 'SAVE_MODS', mods: { pacBypassDomains: ['shared.native-list-a.test'] }, expectedRevision: (await read()).revision });
    await network('shared.native-list-a.test', pacExpected, 'pac-bypass-over-list');
    await ok({ action: 'SAVE_MODS', mods: { pacBypassDomains: [] }, expectedRevision: (await read()).revision });
    await network('native-list-b.test', 'second-proxy', 'automatic-resource-inherits-list', true);
    await write({ action: 'SAVE_DOMAIN_LIST', listId: second, proxyId: a });
    await network('native-list-b.test', 'own-proxy', 'resource-rebind-immediate', true);
    await write({ action: 'SAVE_DOMAIN_LIST', listId: second, proxyId: b });
    await write({ action: 'SAVE_DOMAIN_LIST', listId: second, domains: ['shared.native-list-a.test', 'wild.native-list-a.test', 'native-list-b.test', 'www.native-list-b.test'] });
    await network('www.native-list-b.test', 'origin-direct', 'manual-root-direct-over-exact-list', false,
      { domain: 'native-list-b.test', isProxy: false });
    await network('www.native-list-b.test', 'own-proxy', 'manual-root-proxy-over-exact-list', false,
      { domain: 'native-list-b.test', isProxy: true, proxyId: a });
    await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'native-list-b.test', mode: 'pac' },
      { domain: 'www.native-list-b.test', mode: 'pac' }], expectedRevision: (await read()).revision });
    await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'native-list-cdn.test', mode: 'proxy', proxyId: a }], expectedRevision: (await read()).revision });
    await network('native-list-b.test', 'own-proxy', 'manual-resource-over-list', true);
    const oldRow = row(first);
    document.querySelector('[data-tab="pac"]').click();
    await wait(() => get('tab-pac').classList.contains('active'));
    document.querySelector('[data-tab="exceptions"]').click();
    await wait(() => row(first) !== oldRow && ready());
    row(first).querySelector('.btn-danger').click();
    await wait(() => document.querySelector('dialog[open]'));
    document.querySelector('dialog[open] .btn-primary').click();
    await wait(async () => !(await read()).lists.some(item => item.id === first) && ready());
    assert((await list(second)).domains.includes('shared.native-list-a.test'), 'delete preserves other list duplicates');
    await network('native-list-b.test', 'second-proxy', 'remaining-list-after-delete');
    assert(!networkErrors.length, networkErrors.join('; '));
    return proofs;
  } finally {
    for (const id of ids) if ((await read()).lists.some(item => item.id === id)) await write({ action: 'DELETE_DOMAIN_LIST', listId: id });
    await ok({ action: 'SAVE_MODS', mods: { exceptions: saved.exceptions, whitelist: saved.whitelist,
      pacBypassDomains: saved.pacBypassDomains || [], customProxyStringRaw: saved.customProxyStringRaw,
      ifUseSecureProxiesOnly: saved.ifUseSecureProxiesOnly, ifMindExceptions: saved.ifMindExceptions,
      ifMindWhitelist: saved.ifMindWhitelist, ifProxyHttpsUrlsOnly: saved.ifProxyHttpsUrlsOnly,
      ifUseLocalTor: saved.ifUseLocalTor, ifUseLocalWarp: saved.ifUseLocalWarp,
      ifUseOwnProxiesOnlyForOwnSites: saved.ifUseOwnProxiesOnlyForOwnSites }, expectedRevision: (await read()).revision });
  }
}
