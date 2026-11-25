import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { sendChromeMessage } from './chrome-rpc.js';
import { verifyPortableSettings } from './portable-settings-scenario.js';

// Real, independent HTTP proxy origins. No request interception, synthetic RPC
// responses, or replacement routing implementation is used in this scenario.
async function createProxy(label, credentials) {
  const requests = [];
  const authorized = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    if (credentials && request.headers['proxy-authorization'] !== `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Unroute edit fixture"', 'Connection': 'close' });
      response.end();
      return;
    }
    if (credentials) authorized.push(request.url);
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'text/plain', 'Connection': 'close' });
    response.end(`multiproxy-${label}`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { label, server, requests, authorized, port: server.address().port };
}

export async function verifyMultiproxyRouting(browser, page, worker) {
  const polling = { polling: 50, timeout: 20000 };
  const output = path.resolve('artifacts/multiproxy');
  fs.mkdirSync(output, { recursive: true });
  const send = message => sendChromeMessage(page, message);
  const ok = async message => {
    const result = await send(message);
    assert.equal(result?.success, true, `${message.action}: ${JSON.stringify(result)}`);
    return result;
  };
  const snapshot = async () => (await ok({ action: 'GET_EXCEPTIONS' })).data;
  const previous = (await ok({ action: 'GET_STATE', includeExceptions: true })).data.pacMods;
  const proxies = [await createProxy('A'), await createProxy('B')];
  const directOrigin = await createProxy('DIRECT');
  let probe;
  let counted = false;
  const navigate = async (domain, chosen) => {
    const token = `multiproxy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const url = `http://${domain}/${token}`;
    probe = await browser.newPage();
    try {
      const response = await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      assert.equal(await response.text(), `multiproxy-${chosen.label}`);
      assert.ok(chosen.requests.includes(url), `${url} must arrive at proxy ${chosen.label}`);
      for (const other of proxies.filter(value => value !== chosen)) {
        assert.equal(other.requests.includes(url), false, `${url} must not reach proxy ${other.label}`);
      }
    } finally { await probe.close(); probe = null; }
  };
  const refreshSites = async () => {
    await page.goto(new URL('index.html#exceptions', page.url()).href);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('manualRulesLink').disabled);
    await page.click('#manualRulesLink');
    await page.waitForSelector('#manualSitesEditor #newDomainInput', { visible: true });
    await page.waitForFunction(() => !document.getElementById('newDomainInput').disabled, polling);
  };
  const waitAssignment = async (domain, proxyId) => page.waitForFunction(({ domain, proxyId }) =>
    new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, response =>
      resolve(response?.data?.domainProxyIds?.[domain] === proxyId))), polling, { domain, proxyId })
    .catch(async error => {
      error.message += `\nAssignment ${domain} -> ${proxyId}: ` + JSON.stringify(await snapshot()) +
        '\nUI: ' + await page.$eval('#saveStatusText', node => node.textContent) +
        '\nToast: ' + await page.$eval('#toast', node => node.textContent);
      throw error;
    });
  try {
    await ok({ action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [], customProxyStringRaw: '',
      ifUseLocalTor: false, ifUseLocalWarp: false, ifUseSecureProxiesOnly: false,
      ifProxyHttpsUrlsOnly: false, ifMindWhitelist: false, ifProxyOrDie: true,
      ifUseOwnProxiesOnlyForOwnSites: true } });
    await ok({ action: 'INSTALL_PAC', key: 'onlyOwnSites' });
    await page.goto(new URL('index.html#proxies', page.url()).href);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('extVersion').textContent, polling);
    // Exercise named addition through the real form and its mandatory native
    // health probe, not a raw storage/catalog seed.
    for (const proxy of proxies) {
      await page.evaluate(({ port, label }) => {
        document.getElementById('proxyName').value = `Smoke ${label}`;
        document.getElementById('proxyProtocol').value = 'HTTP';
        document.getElementById('proxyProtocol').dispatchEvent(new Event('change'));
        document.getElementById('proxyHost').value = '127.0.0.1';
        document.getElementById('proxyPort').value = String(port);
        if (document.getElementById('proxyAuthCheck').checked) document.getElementById('proxyAuthCheck').click();
        document.getElementById('addProxyBtn').click();
      }, { port: proxy.port, label: proxy.label });
      await page.waitForFunction(count => document.querySelectorAll('#proxyCardsList .proxy-status-tag.online').length === count &&
        !document.getElementById('addProxyBtn').disabled,
      polling, proxies.indexOf(proxy) + 1).catch(async error => {
        error.message += '\nProxy form diagnostics: ' + JSON.stringify(await page.evaluate(() => ({
          alert: document.getElementById('proxyFormAlert')?.textContent,
          cards: document.getElementById('proxyCardsList')?.textContent,
          toast: document.getElementById('toast')?.textContent,
        }))) + '\nCatalog: ' + JSON.stringify(await snapshot()) + '\nProxy requests: ' + JSON.stringify(proxy.requests);
        throw error;
      });
      assert.ok(proxy.requests.some(url => url.includes('health-probe.test/')), 'Addition must really probe the selected proxy');
    }
    console.log('Chrome multiproxy: two proxies added and probed');
    let rules = await snapshot();
    const a = rules.proxyCatalog.find(profile => profile.name === 'Smoke A');
    const b = rules.proxyCatalog.find(profile => profile.name === 'Smoke B');
    assert.match(a.id, /^custom:/);
    assert.match(b.id, /^custom:/);
    assert.notEqual(a.id, b.id);
    assert.equal(rules.defaultProxyId, a.id, 'Adding B must not change default A');
    for (const [id, name] of [['builtin:tor', 'Tor'], ['builtin:warp', 'Cloudflare WARP']]) {
      const builtin = rules.proxyCatalog.find(profile => profile.id === id);
      assert.equal(builtin?.name, name);
      assert.equal(builtin?.builtin, true);
      assert.equal(builtin?.enabled, false);
    }
    // Count calls while delegating unchanged to the actual native PAC backend.
    await worker.evaluate(() => {
      const backend = globalThis.__proxyTestHooks.proxyBackend;
      const original = backend.applyPac;
      globalThis.multiproxyNative = { original, writes: 0 };
      backend.applyPac = function(...args) {
        globalThis.multiproxyNative.writes++;
        return original.apply(this, args);
      };
    });
    counted = true;
    const revision = rules.revision;
    await page.select('#defaultProxySelect', b.id);
    await page.waitForFunction(id => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' },
      response => resolve(response?.data?.defaultProxyId === id))), polling, b.id);
    await ok({ action: 'RENAME_PROXY_PROFILE', proxyId: a.id, name: 'Smoke A renamed' });
    rules = await snapshot();
    assert.equal(rules.proxyCatalog.find(profile => profile.name === 'Smoke A renamed').id, a.id);
    assert.equal(rules.defaultProxyId, b.id);
    assert.equal(rules.revision, revision, 'Name/default metadata must not change rules revision');
    assert.equal(await worker.evaluate(() => globalThis.multiproxyNative.writes), 0, 'Rename/default must not apply PAC');

    console.log('Chrome multiproxy: metadata verified, adding sites');
    await page.bringToFront();
    await refreshSites();
    assert.equal(await page.$eval('#newRuleProxy', select => select.value), b.id, 'New-site selector must use the default');
    // Explicitly choose A for one new site; default B for another.
    for (const [domain, id] of [['route-a.test', a.id], ['route-b.test', b.id]]) {
      await page.select('#newRuleProxy', id);
      await page.$eval('#newDomainInput', (input, value) => { input.value = value; }, domain);
      await page.click('#addDomainBtn');
      await waitAssignment(domain, id);
      await page.waitForFunction(() => !document.getElementById('addDomainBtn').disabled &&
        document.getElementById('newDomainInput').value === '', polling);
    }
    console.log('Chrome multiproxy: checking A/B network routing');
    await navigate('route-a.test', proxies[0]);
    await navigate('route-b.test', proxies[1]);
    // Open the actual packaged popup against an active A tab. Only its CDN row
    // is edited; real requests must move to B without moving the main domain.
    const resourceHost = 'asset.popup-cdn.test';
    await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: '*.popup-cdn.test', mode: 'proxy', proxyId: a.id }] });
    const site = await browser.newPage();
    let popup;
    try {
      await site.goto('http://route-a.test/multiproxy-popup-main');
      const fetchResource = async (chosen, host = resourceHost) => {
        const url = `http://${host}/multiproxy-popup-${Date.now()}-${Math.random()}`;
        assert.equal(await site.evaluate(url => fetch(url, { cache: 'no-store' }).then(response => response.text()), url),
          `multiproxy-${chosen.label}`);
        assert.ok(chosen.requests.includes(url));
        assert.ok(proxies.filter(proxy => proxy !== chosen).every(proxy => !proxy.requests.includes(url)));
      };
      await fetchResource(proxies[0]);
      const tabId = await page.evaluate(() => new Promise(resolve => chrome.tabs.query({}, tabs =>
        resolve(tabs.find(tab => tab.url?.includes('route-a.test/multiproxy-popup-main'))?.id))));
      assert.ok(Number.isInteger(tabId));
      await page.waitForFunction(({ tabId, resourceHost }) => new Promise(resolve =>
        chrome.runtime.sendMessage({ action: 'GET_STATE', currentDomain: 'route-a.test', currentTabId: tabId }, response =>
          resolve(response?.data?.siteResources?.hosts.includes(resourceHost)))), polling, { tabId, resourceHost });
      popup = await browser.newPage();
      await popup.goto(new URL('../popup/index.html', page.url()).href);
      await site.bringToFront();
      await popup.reload();
      await popup.waitForFunction(() => document.getElementById('domain').textContent === 'route-a.test', polling);
      await popup.$eval('#resourceDetails', details => { details.open = true; });
      const readRow = host => popup.$$eval('#resources li', (rows, host) => {
        const row = rows.find(row => row.querySelector('.resource-domain')?.textContent === host);
        const select = row?.querySelector('select');
        return select ? { value: select.value, disabled: select.disabled, origin: row.dataset.origin, title: select.title,
          options: [...select.options].map(option => ({ value: option.value, disabled: option.disabled })) } : null;
      }, host);
      assert.equal(await popup.$$eval('#resources .resource-domain', nodes => nodes.some(node => node.textContent === 'route-a.test')), false,
        'The main host is controlled once above the resource list');
      const initial = await readRow(resourceHost);
      assert.ok(initial, 'Collected resource must render a real per-resource proxy select');
      assert.equal(initial.value, a.id, 'The manually seeded wildcard must display its assigned profile, not Automatic');
      assert.equal(initial.origin, 'manual');
      assert.ok(initial.title.includes('*.popup-cdn.test'));
      assert.ok(initial.options.some(option => option.value === b.id && !option.disabled));
      const before = await snapshot();
      assert.equal(await popup.$$eval('#siteProxyWrap .proxy-name-label', nodes => nodes.length), 0);
      assert.equal(initial.options.some(option => option.value === '@automatic'), false, 'A manual wildcard is not an automatic policy');
      const currentName = before.proxyCatalog.find(profile => profile.id === a.id).name;
      assert.ok((await popup.$eval('.site-proxy', select => select.title)).includes(currentName));
      assert.ok((await popup.$eval('.site-proxy', (select, id) => [...select.options].find(option => option.value === id).textContent, a.id)).includes(currentName),
        'the full-width site menu retains full profile names');
      await popup.$$eval('#resources li', (rows, { host, id }) => {
        const select = rows.find(row => row.querySelector('.resource-domain')?.textContent === host).querySelector('select');
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, { host: resourceHost, id: b.id });
      await waitAssignment(resourceHost, b.id);
      await popup.waitForFunction(({ host, id }) => {
        const select = [...document.querySelectorAll('#resources li')]
          .find(row => row.querySelector('.resource-domain')?.textContent === host)?.querySelector('select');
        return select?.value === id && !select.disabled;
      }, polling, { host: resourceHost, id: b.id });
      const after = await snapshot();
      assert.equal(after.domainProxyIds['route-a.test'], a.id);
      assert.equal(after.domainProxyIds['route-b.test'], b.id);
      assert.equal(after.defaultProxyId, before.defaultProxyId);
      const withoutResource = rules => ({ exceptions: Object.fromEntries(Object.entries(rules.exceptions).filter(([host]) => host !== resourceHost)),
        assignments: Object.fromEntries(Object.entries(rules.domainProxyIds).filter(([host]) => host !== resourceHost)) });
      assert.deepEqual(withoutResource(after), withoutResource(before), 'Only the exact selected resource rule may change');
      await fetchResource(proxies[1]);
      await popup.reload();
      await popup.waitForFunction(({ host, id }) => [...document.querySelectorAll('#resources li')]
        .find(row => row.querySelector('.resource-domain')?.textContent === host)?.querySelector('select')?.value === id,
      polling, { host: resourceHost, id: b.id });
      const beforeIgnored = await snapshot();
      await ok({ action: 'SAVE_MODS', mods: { ifMindExceptions: false } });
      try {
        await popup.waitForFunction(() => document.querySelector('#resources select')?.disabled &&
          document.getElementById('scope').textContent.includes(chrome.i18n.getMessage('popupResourceRulesDisabled')), polling);
        await popup.$$eval('#resources li', (rows, { host, id }) => {
          const select = rows.find(row => row.querySelector('.resource-domain')?.textContent === host).querySelector('select');
          select.value = id;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }, { host: resourceHost, id: a.id });
        await popup.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
        assert.deepEqual((await snapshot()).domainProxyIds, beforeIgnored.domainProxyIds, 'Disabled site rules must not accept a misleading resource mutation');
      } finally {
        await ok({ action: 'SAVE_MODS', mods: { ifMindExceptions: true } });
      }
      console.log('Chrome popup resource proxy: displayed A, selected B, persisted exact CDN rule, real CDN traffic reached only B; site A/default/other rules unchanged; disabled site rules lock the selector.');
      const inheritedHost = 'auto.popup-inherit.test';
      const manualSameSite = 'manual.route-a.test';
      const lateHost = 'late.popup-inherit.test';
      const discover = async (host, id, chosen) => {
        // The first request discovers a previously unknown external resource.
        // It may fail before the real background batch installs its rule.
        await site.evaluate(host => fetch(`http://${host}/discover-${Date.now()}`,
          { signal: AbortSignal.timeout(3000) }).catch(() => null), host);
        await waitAssignment(host, id);
        await fetchResource(chosen, host);
      };
      await discover(inheritedHost, a.id, proxies[0]);
      const directHost = 'direct.cdn.test'; // existing Chrome DNS fixture maps *.cdn.test to loopback
      const fetchDirectResource = async (label, host = directHost) => {
        const url = `http://${host}:${directOrigin.port}/direct-resource-${Date.now()}-${Math.random()}`;
        assert.equal(await site.evaluate(url => fetch(url, { cache: 'no-store' }).then(response => response.text()), url), `multiproxy-${label}`);
        if (label === 'DIRECT') {
          assert.ok(directOrigin.requests.includes(new URL(url).pathname), 'Direct request must reach the actual origin');
          for (const proxy of proxies) assert.equal(proxy.requests.includes(url), false, 'Direct request must bypass both proxies');
        } else assert.ok(proxies.find(proxy => proxy.label === label).requests.includes(url));
      };
      await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: directHost, mode: 'proxy', proxyId: b.id }] });
      await fetchDirectResource('B');
      await popup.reload();
      await popup.waitForFunction(host => [...document.querySelectorAll('#resources select')].some(select => select.dataset.host === host && !select.disabled), polling, directHost);
      await popup.select(`#resources select[data-host="${directHost}"]`, '@direct');
      await page.waitForFunction(host => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, result =>
        resolve(result.data.exceptions[host] === false && !Object.hasOwn(result.data.domainProxyIds, host)))), polling, directHost);
      await popup.waitForFunction(host => document.querySelector(`#resources select[data-host="${host}"]`)?.value === '@direct' &&
        document.body.getAttribute('aria-busy') === 'false', polling, directHost);
      await fetchDirectResource('DIRECT');
      await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: manualSameSite, mode: 'proxy', proxyId: b.id }] });
      await fetchResource(proxies[1], manualSameSite);
      const setSiteProxy = async id => {
        // Reload reads a coherent displayed revision after discovery batches.
        await popup.reload();
        await popup.waitForSelector('.site-proxy:not(:disabled)', polling);
        await popup.select('.site-proxy', id);
        await waitAssignment('route-a.test', id);
        await popup.waitForFunction(id => document.querySelector('.site-proxy')?.value === id &&
          document.body.getAttribute('aria-busy') === 'false', polling, id);
      };
      await setSiteProxy(b.id);
      await waitAssignment(inheritedHost, b.id);
      console.log('Chrome popup inheritance baseline: parent B, owned resources B');
      await fetchResource(proxies[1], inheritedHost);
      await fetchResource(proxies[1], 'route-a.test');
      await discover(lateHost, b.id, proxies[1]);
      await setSiteProxy(a.id);
      await waitAssignment(inheritedHost, a.id);
      console.log('Chrome popup inheritance baseline: parent A restored');
      await waitAssignment(lateHost, a.id);
      const finalSiteRules = await snapshot();
      assert.equal(finalSiteRules.domainProxyIds[manualSameSite], b.id, 'manual same-site subdomain must survive parent proxy switches');
      assert.equal(finalSiteRules.domainProxyIds[resourceHost], b.id, 'manual external resource must survive parent proxy switches');
      assert.equal(finalSiteRules.exceptions[directHost], false, 'manual Direct resource must survive parent proxy switches');
      assert.equal(Object.hasOwn(finalSiteRules.domainProxyIds, directHost), false);
      await fetchDirectResource('DIRECT');
      assert.equal(finalSiteRules.defaultProxyId, before.defaultProxyId, 'site selection must not change the catalog default');
      await fetchResource(proxies[0], inheritedHost);
      await fetchResource(proxies[0], lateHost);
      await fetchResource(proxies[1], manualSameSite);
      await fetchResource(proxies[1]);
      const policyHost = 'auto.policy.cdn.test';
      console.log('Chrome popup inheritance policy: discovering automatic resource');
      const latePolicyHost = 'late.policy.cdn.test';
      const wildcardHost = 'wild.route-a.test';
      await site.evaluate(({ host, port }) => fetch(`http://${host}:${port}/discover-policy`, { cache: 'no-store' }).catch(() => null),
        { host: policyHost, port: directOrigin.port });
      await waitAssignment(policyHost, a.id);
      await fetchDirectResource('A', policyHost);
      await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: '*.route-a.test', mode: 'proxy', proxyId: b.id }] });
      await fetchResource(proxies[1], wildcardHost);
      const setInheritance = async value => {
        await popup.reload();
        await popup.waitForSelector('#inheritResources:not(:disabled)', polling);
        assert.notEqual(await popup.$eval('#inheritResources', input => input.checked), value);
        // Keep the fixture site active: Puppeteer's pointer click waits for
        // intersection/scroll on the hidden popup tab and can stall forever.
        await popup.$eval(value ? '#inheritResources' : '#directResources', input => input.click());
        await popup.waitForFunction(value => document.getElementById('inheritResources').checked === value &&
          !document.getElementById('inheritResources').disabled && document.body.getAttribute('aria-busy') === 'false', polling, value)
          .catch(async error => { error.message += '\nInheritance notice: ' + await popup.$eval('#notice', node => node.textContent); throw error; });
      };
      await setInheritance(false);
      assert.equal((await snapshot()).domainProxyIds['route-a.test'], a.id, 'inheritance must not change the main domain');
      await fetchDirectResource('DIRECT', policyHost);
      await fetchResource(proxies[0], 'route-a.test');
      await fetchResource(proxies[1], wildcardHost);
      await fetchResource(proxies[1], manualSameSite);
      await fetchResource(proxies[1], resourceHost);
      await site.evaluate(({ host, port }) => fetch(`http://${host}:${port}/discover-late-policy`, { cache: 'no-store' }).catch(() => null),
        { host: latePolicyHost, port: directOrigin.port });
      await page.waitForFunction(host => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, response =>
        resolve(response?.data?.exceptions[host] === false))), polling, latePolicyHost);
      await fetchDirectResource('DIRECT', latePolicyHost);
      await popup.reload();
      await popup.waitForSelector('#inheritResources:not(:disabled)', polling);
      assert.equal(await popup.$eval('#inheritResources', input => input.checked), false, 'policy survives popup reload');
      await setSiteProxy(b.id);
      await fetchDirectResource('DIRECT', policyHost);
      await popup.select('#siteRoute', '@direct');
      await page.waitForFunction(() => new Promise(resolve => chrome.runtime.sendMessage({ action: 'GET_EXCEPTIONS' }, response =>
        resolve(response?.data?.exceptions['route-a.test'] === false))), polling);
      await popup.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false', polling);
      await fetchResource(proxies[1], wildcardHost);
      await fetchResource(proxies[1], manualSameSite);
      await fetchResource(proxies[1], resourceHost);
      await fetchDirectResource('DIRECT');
      await setSiteProxy(a.id);
      await setInheritance(true);
      await waitAssignment(policyHost, a.id);
      await waitAssignment(latePolicyHost, a.id);
      await fetchDirectResource('A', policyHost);
      await fetchDirectResource('A', latePolicyHost);
      const afterInheritance = await snapshot();
      assert.equal(afterInheritance.domainProxyIds['*.route-a.test'], b.id, 'main Direct must not overwrite a manually assigned root wildcard');
      assert.equal(Object.hasOwn(afterInheritance.exceptions, wildcardHost), false, 'inheritance must not shadow a manual wildcard with an exact automatic rule');
      assert.equal(afterInheritance.defaultProxyId, before.defaultProxyId);
      console.log('Chrome inheritance switch: automatic A→DIRECT→A, late resources direct while off, main route unchanged by the switch, manual proxy/DIRECT/wildcard survived main Direct and popup reload.');
      const resetHost = 'reset.policy.cdn.test';
      const fallbackHost = 'manual.reset.cdn.test';
      const chooseResource = async (host, value) => {
        await popup.reload();
        const selector = `#resources select[data-host="${host}"]`;
        await popup.waitForSelector(selector + ':not(:disabled)', polling);
        await popup.select(selector, value);
        await popup.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false', polling);
        assert.equal(await popup.$eval('#notice', node => node.hidden), true, await popup.$eval('#notice', node => node.textContent));
      };
      await site.evaluate(({ host, port }) => fetch(`http://${host}:${port}/discover-reset`, { cache: 'no-store' }).catch(() => null),
        { host: resetHost, port: directOrigin.port });
      await waitAssignment(resetHost, a.id);
      await popup.reload();
      await popup.waitForFunction(host => document.querySelector(`#resources select[data-host="${host}"]`)?.value === '@automatic', polling, resetHost);
      await chooseResource(resetHost, a.id);
      assert.equal(await popup.$eval(`#resources select[data-host="${resetHost}"]`, select => select.closest('li').dataset.origin), 'manual', 'the same profile as the site is still manually pinned');
      await chooseResource(resetHost, '@reset-exact');
      assert.equal(await popup.$eval(`#resources select[data-host="${resetHost}"]`, select => select.closest('li').dataset.origin), 'site');
      assert.equal(await popup.$eval(`#resources select[data-host="${resetHost}"]`, select => select.value), '@automatic');
      await fetchDirectResource('A', resetHost);
      await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: '*.reset.cdn.test', mode: 'proxy', proxyId: b.id }] });
      await fetchDirectResource('B', fallbackHost);
      await chooseResource(fallbackHost, '@direct');
      await fetchDirectResource('DIRECT', fallbackHost);
      await chooseResource(fallbackHost, '@reset-exact');
      await fetchDirectResource('B', fallbackHost);
      const wildcardAfterReset = await snapshot();
      assert.equal(wildcardAfterReset.domainProxyIds['*.reset.cdn.test'], b.id);
      assert.equal(Object.hasOwn(wildcardAfterReset.exceptions, fallbackHost), false);
      assert.equal(await popup.$eval(`#resources select[data-host="${fallbackHost}"]`, select =>
        select.closest('li').dataset.origin === 'manual' && ![...select.options].some(option => option.value === '@reset-exact')), true);
      await setInheritance(false);
      await chooseResource(resetHost, b.id);
      await fetchDirectResource('B', resetHost);
      await chooseResource(resetHost, '@reset-exact');
      await fetchDirectResource('DIRECT', resetHost);
      await setInheritance(true);
      await waitAssignment(resetHost, a.id);
      await fetchDirectResource('A', resetHost);
      console.log('Chrome resource UX: native segmented setting; same-profile manual pin; exact reset→site/wildcard/DIRECT with real traffic and untouched wildcard.');
      await popup.$eval('#resourceDetails', details => { details.open = true; });
      for (const theme of ['light', 'dark']) {
        await popup.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await popup.screenshot({ path: path.join(output, `chrome-popup-site-proxy-${theme}.png`) });
      }
      assert.equal(await popup.$eval('#actionScope', node => node.hidden), true);
      assert.equal(await popup.$eval('#notice', node => node.hidden), true);
      assert.ok(await popup.$eval('#route', node => Boolean(node.title)));
      console.log('Chrome popup site proxy: A→B→A through the actual selector; inherited and late CDN requests followed; manual same-site/external resources stayed B; default unchanged; compact status tooltip verified.');
      console.log('Chrome popup Direct: selected in the real resource dropdown; proxy B→actual direct origin, neither proxy received Direct requests; manual Direct survived site A→B→A.');
      const beforeReload = proxies[0].requests.filter(url => url.includes('/multiproxy-popup-main')).length;
      await Promise.all([site.waitForNavigation({ waitUntil: 'load', timeout: 15000 }), popup.$eval('#reload', button => button.click())]);
      assert.ok(proxies[0].requests.filter(url => url.includes('/multiproxy-popup-main')).length > beforeReload, 'reload action must really reload the fixture site through its main proxy');
      popup = null;
      console.log('Chrome reload action: actual site navigation and a new main-document request verified.');
    } finally {
      if (popup) await popup.close();
      await site.close();
      await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [resourceHost, '*.popup-cdn.test',
        'auto.popup-inherit.test', 'late.popup-inherit.test', 'manual.route-a.test', 'direct.cdn.test',
        'auto.policy.cdn.test', 'late.policy.cdn.test', '*.route-a.test', 'wild.route-a.test',
        'reset.policy.cdn.test', 'manual.reset.cdn.test', '*.reset.cdn.test'].map(domain => ({ domain, mode: 'pac' })) });
    }
    await page.bringToFront();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    const originalTheme = await page.$eval('#appearanceTheme', select => select.value);
    for (const theme of ['light', 'dark']) {
      await page.$eval('[data-tab="appearance"]', button => button.click());
      await page.select('#appearanceTheme', theme);
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, polling, theme);
      for (const tab of ['proxies', 'exceptions']) {
        await page.$eval(`[data-tab="${tab}"]`, button => button.click());
        await page.waitForFunction(value => document.querySelector(`#tab-${value}.active`), polling, tab);
        await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
        await page.screenshot({ path: path.join(output, `chrome-${tab === 'exceptions' ? 'sites' : tab}-${theme}.png`) });
      }
    }
    await page.$eval('[data-tab="appearance"]', button => button.click());
    await page.select('#appearanceTheme', originalTheme);
    await page.$eval('[data-tab="exceptions"]', button => button.click());
    await page.bringToFront();
    await refreshSites();
    await page.select('.domain-proxy-select[data-domain="route-a.test"]', b.id);
    await waitAssignment('route-a.test', b.id);
    await navigate('route-a.test', proxies[1]);

    // Import more than one rendered chunk, then select ALL filtered results.
    // This proves the operation includes non-DOM rows, with actual routing too.
    console.log('Chrome multiproxy: checking import and filtered bulk');
    await page.bringToFront();
    await page.select('#newRuleProxy', a.id);
    const imported = Array.from({ length: 125 }, (_, index) => `bulk-${String(index).padStart(3, '0')}.test`);
    await page.evaluate(domains => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([domains.join('\n')], 'multiproxy.txt', { type: 'text/plain' }));
      const input = document.getElementById('fileImportInput');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    }, imported);
    await waitAssignment(imported.at(-1), a.id);
    await page.waitForFunction(() => !document.getElementById('addDomainBtn').disabled, polling);
    rules = await snapshot();
    for (const domain of imported) assert.equal(rules.domainProxyIds[domain], a.id);
    await navigate(imported.at(-1), proxies[0]);
    await page.bringToFront();
    await page.select('#proxyFilter', a.id);
    assert.equal(await page.$$eval('.domain-card', cards => cards.length), 100);
    await page.click('#selectAllFiltered');
    assert.match(await page.$eval('#selectionCount', node => node.textContent), /125/);
    await page.select('#bulkProxy', b.id);
    await page.click('#bulkAssign');
    await waitAssignment(imported.at(-1), b.id);
    await page.waitForFunction(() => !document.getElementById('addDomainBtn').disabled, polling);
    rules = await snapshot();
    for (const domain of imported) assert.equal(rules.domainProxyIds[domain], b.id);
    assert.equal(await page.$$eval('.domain-card', cards => cards.length), 0, 'A-filter must empty after full filtered batch move');
    await navigate(imported.at(-1), proxies[1]);
    const stale = await send({ action: 'ASSIGN_DOMAIN_PROXIES', domains: ['route-a.test'], proxyId: a.id, expectedRevision: revision });
    assert.equal(stale.success, false, 'Intentionally stale revision must not be repaired by test helper');
    const staleReplacement = await send({ action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [] }, expectedRevision: revision });
    assert.equal(staleReplacement.success, false, 'Setup helper must preserve an explicit stale SAVE_MODS revision');
    assert.equal((await snapshot()).domainProxyIds['route-a.test'], b.id);
    console.log('Chrome multiproxy network proof passed: two real HTTP origins; named health-checked additions, stable IDs, built-ins, default/rename without PAC writes; A→A/B→B, site move A→B, import 125→A, filter/select-all/bulk 125→B and real traffic on each route.');
    await page.bringToFront();
    await page.$eval('[data-tab="proxies"]', button => button.click());
    assert.deepEqual(await page.$$eval('.proxy-profile-name', names => names.map(node => node.textContent)),
      ['Smoke A renamed', 'Smoke B'], 'The real proxy cards must display their persisted names');
    assert.equal(await page.$$eval('.edit-proxy-btn, .delete-btn', buttons => buttons.some(button => button.disabled)),
      false, 'Named proxy cards must bind rename/delete controls to their stable IDs');

    // Edit a saved connection through the actual packaged form. Rejected
    // duplicates keep the complete draft; a successful endpoint/auth edit keeps
    // its ID, assignments and reserve binding and must pass native HTTP auth.
    const credentials = { username: 'edit-fixture-user', password: ' edited@fixture:password ' };
    const editedProxy = await createProxy('Edited A', credentials);
    proxies.push(editedProxy);
    await ok({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'edit-bound.test', mode: 'proxy', proxyId: a.id }] });
    await ok({ action: 'SAVE_MODS', mods: { fallbackProxyId: a.id, ifProxyOrDie: true } });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.edit-proxy-btn:not(:disabled)'), polling);
    await page.$eval('[data-tab="proxies"]', button => button.click());
    await page.click('.edit-proxy-btn');
    const form = '.proxy-connection-editor';
    assert.equal(await page.$eval(`${form} [name="hasAuth"]`, input => input.checked), false);
    assert.equal(await page.$eval(`${form} [name="username"]`, input => input.getClientRects().length), 0, 'no saved auth means no visible credential fields');
    assert.equal(await page.$eval(form, editor => editor.closest('.proxy-item').querySelector('.proxy-actions').getClientRects().length), 0, 'active proxy actions are hidden');
    const fill = async (name, value) => page.$eval(`${form} [name="${name}"]`, (input, value) => {
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
    await fill('name', 'Edited A');
    await fill('host', '127.0.0.1');
    await fill('port', proxies[1].port);
    await page.click(`${form} [name="hasAuth"]`);
    assert.equal(await page.$eval(`${form} [name="username"]`, input => input.getClientRects().length > 0), true, 'checking auth reveals credentials');
    await fill('username', credentials.username);
    await fill('password', credentials.password);
    await page.click(`${form} [type="submit"]`);
    await page.waitForFunction(() => document.querySelector('.proxy-connection-error')?.textContent.length > 0, polling);
    assert.equal(await page.$eval(form, editor => editor.closest('.proxy-item').querySelector('.proxy-actions').getClientRects().length), 0, 'rejected saves keep proxy actions hidden');
    assert.equal(await page.$eval(`${form} [name="password"]`, input => input.value), credentials.password);
    assert.equal((await snapshot()).proxyCatalog.find(profile => profile.id === a.id).endpoint, `PROXY 127.0.0.1:${proxies[0].port}`);
    await fill('port', editedProxy.port);
    await page.click(`${form} [type="submit"]`);
    await page.waitForFunction(() => !document.querySelector('.proxy-connection-editor'), polling);
    const edited = (await ok({ action: 'GET_STATE', includeExceptions: true })).data.pacMods;
    assert.equal(edited.proxyCatalog.find(profile => profile.id === a.id).name, 'Edited A');
    assert.equal(edited.proxyCatalog.find(profile => profile.id === a.id).endpoint, `PROXY 127.0.0.1:${editedProxy.port}`);
    assert.equal(edited.domainProxyIds['edit-bound.test'], a.id);
    assert.equal(edited.domainProxyIds['route-b.test'], b.id);
    assert.equal(edited.defaultProxyId, b.id);
    assert.equal(edited.fallbackProxyId, a.id);
    await navigate('edit-bound.test', editedProxy);
    assert.ok(editedProxy.authorized.some(url => url.includes('edit-bound.test')), 'The edited credentials must authenticate a real browser proxy request');
    await page.bringToFront();
    assert.equal(await page.$eval('.proxy-item .proxy-actions', node => node.getClientRects().length > 0), true, 'saved edits restore proxy actions');
    await page.click('.edit-proxy-btn');
    assert.equal(await page.$eval(`${form} [name="hasAuth"]`, input => input.checked), true, 'saved auth is enabled when reopening the editor');
    assert.equal(await page.$eval(`${form} [name="username"]`, input => input.value), credentials.username);
    assert.equal(await page.$eval(`${form} [name="password"]`, input => input.value), credentials.password);
    await page.waitForSelector(`${form} [name="password"]`, { visible: true });
    assert.equal(await page.evaluate(selector => document.querySelector(selector).getClientRects().length > 0, `${form} [name="password"]`), true);
    // Focus-triggered state refresh can replace the editor before the click.
    await page.locator(`${form} .proxy-editor-actions [type="button"]`).click();
    assert.equal(await page.$eval('.proxy-item .proxy-actions', node => node.getClientRects().length > 0), true, 'cancelling restores proxy actions');
    await verifyPortableSettings(browser, page, { primaryId: a.id, reserveId: b.id, password: credentials.password });
    await navigate('edit-bound.test', editedProxy);
    await ok({ action: 'SAVE_MODS', mods: { fallbackProxyId: null } });
    console.log('Chrome saved proxy edit: duplicate rejected with draft retained; stable ID/default/assignments/reserve; changed endpoint and whitespace-bearing credentials passed native HTTP proxy authentication.');
  } finally {
    try {
      if (probe) await probe.close();
      if (counted) await worker.evaluate(() => {
        globalThis.__proxyTestHooks.proxyBackend.applyPac = globalThis.multiproxyNative.original;
        delete globalThis.multiproxyNative;
      });
      // Remove assignments before removing their endpoints. Never send serialized
      // read-only registry/assignment fields through preference SAVE_MODS.
      await ok({ action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [] } });
      const restore = Object.fromEntries(Object.entries(previous).filter(([key]) => ![
        'proxyProfiles', 'proxyCatalog', 'domainProxyIds', 'defaultProxyId', 'proxyCatalogRevision',
        'rulesRevision', 'exceptionStats', 'exceptions', 'whitelist', 'ruleMeta', 'ruleHistory',
      ].includes(key)));
      await ok({ action: 'SAVE_MODS', mods: restore });
      await ok({ action: 'SAVE_MODS', mods: { exceptions: previous.exceptions, whitelist: previous.whitelist } });
    } finally {
      for (const proxy of [...proxies, directOrigin]) {
        proxy.server.closeAllConnections();
        await new Promise(resolve => proxy.server.close(resolve));
      }
    }
  }
}
