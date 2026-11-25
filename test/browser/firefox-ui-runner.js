/* global checkSitesEditor, sendFirefoxFixtureMessage, checkLimitsAndHelp, checkDomainListsNative, checkProxyFailover */
// Copied only into the temporary Firefox test extension. BiDi deliberately
// does not expose extension documents; run DOM checks in their own context.
export async function runFirefoxUiChecks(reportUrl, ownProxy, requestedLocale, networkConfig) {
  const report = data => fetch(reportUrl, { method: 'POST', body: JSON.stringify(data) });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async predicate => {
    const end = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > end) throw new Error('UI state timeout');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const get = id => document.getElementById(id);
  const send = sendFirefoxFixtureMessage;
  const failoverProofs = [];
  try {
    if (networkConfig?.failoverOnly) {
      await wait(() => get('extVersion')?.textContent && get('proxyFailoverSelect'));
      const proofs = await checkProxyFailover({ proofs: failoverProofs, ...networkConfig, suffix: 'localhost', send,
        select: async value => {
          await wait(() => [...get('proxyFailoverSelect').options].some(option => option.value === value));
          if (value === 'direct') window.confirm = () => true;
          get('proxyFailoverSelect').value = value;
          get('proxyFailoverSelect').dispatchEvent(new Event('change', { bubbles: true }));
          await wait(() => !get('proxyFailoverSelect').disabled && document.body.getAttribute('aria-busy') !== 'true');
        },
        probe: async url => {
          let error = null;
          const observe = details => { if (details.url === url) error = details.error; };
          browser.webRequest.onErrorOccurred.addListener(observe, { urls: ['<all_urls>'], types: ['main_frame'] });
          const tab = await browser.tabs.create({ url, active: false });
          try {
            await wait(async () => { const current = await browser.tabs.get(tab.id); return error || (current.status === 'complete' && current.url === url); });
            if (error) {
              // A tab-associated request takes Firefox's native onRequest
              // path. Compare its failure with an extension-background fetch,
              // which has no tab association and therefore uses native PAC.
              let pacDiagnostic;
              if (url.endsWith('/proxy-failover-refused-explicit-direct')) {
                const pacUrl = url + '-pac-diagnostic';
                try { pacDiagnostic = { url: pacUrl, body: await (await fetch(pacUrl, {cache:'no-store'})).text(), error: null }; }
                catch (cause) { pacDiagnostic = { url: pacUrl, body: null, error: cause.message }; }
              }
              return { body: null, error, ...(pacDiagnostic ? {pacDiagnostic} : {}) };
            }
            return { body: (await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.textContent }))[0].result, error: null };
          } finally {
            browser.webRequest.onErrorOccurred.removeListener(observe);
            await browser.tabs.remove(tab.id);
          }
        },
      });
      await report({ done: true, uiDone: true, stage: 'proxy-failover-pass', proofs });
      return;
    }
    const resourceTest = new URL(location.href).searchParams;
    if (resourceTest.has('resourceProxyTest')) {
      const tabId = Number(resourceTest.get('tabId'));
      const a = resourceTest.get('a');
      const b = resourceTest.get('b');
      const host = 'popup-cdn.test';
      const rowSelect = () => [...document.querySelectorAll('#resources li')]
        .find(row => row.querySelector('.resource-domain')?.textContent === host)?.querySelector('select');
      try {
        await wait(() => get('domain').textContent === 'route-a.test' &&
          [...document.querySelectorAll('#resources .resource-domain')].some(node => node.textContent === host));
        get('resourceDetails').open = true;
        assert(rowSelect(), 'Collected resource must render a real per-resource proxy select');
        assert(![...document.querySelectorAll('#resources .resource-domain')].some(node => node.textContent === 'route-a.test'), 'Main host is controlled only by the site selector');
        assert(Number(get('resourceCount').textContent) === document.querySelectorAll('#resources li').length, 'Count must describe visible resources');
        assert(rowSelect().value === '@automatic' && rowSelect().selectedOptions[0].disabled, 'Automatic resource must show a disabled policy placeholder');
        assert([...rowSelect().options].some(option => option.value === b && !option.disabled), 'Proxy B must be selectable');
        const before = (await send({ action: 'GET_EXCEPTIONS' })).data;
        const currentName = before.proxyCatalog.find(proxy => proxy.id === a).name;
        assert(!document.querySelector('#siteProxyWrap .proxy-name-label'), 'Wide site selector has no shortened overlay');
        assert(get('siteRoute').selectedOptions[0].textContent.includes(currentName), 'Site selector retains full profile name');
        assert(!rowSelect().parentElement.querySelector('.proxy-name-label'), 'Automatic placeholder is not a shortened manual proxy label');
        assert([...rowSelect().options].find(option => option.value === a).textContent === currentName && rowSelect().title.includes(currentName), 'Full proxy names must remain in the native dropdown and tooltip');
        rowSelect().value = b;
        rowSelect().dispatchEvent(new Event('change', { bubbles: true }));
        await wait(async () => (await send({ action: 'GET_EXCEPTIONS' })).data.domainProxyIds[host] === b);
        await wait(() => rowSelect()?.value === b && !rowSelect().disabled);
        const after = (await send({ action: 'GET_EXCEPTIONS' })).data;
        assert(after.domainProxyIds['route-a.test'] === a, 'Resource edit moved the main site');
        assert(after.defaultProxyId === before.defaultProxyId, 'Resource edit changed default proxy');
        const withoutResource = rules => JSON.stringify({
          exceptions: Object.entries(rules.exceptions).filter(([domain]) => domain !== host).sort(),
          assignments: Object.entries(rules.domainProxyIds).filter(([domain]) => domain !== host).sort(),
        });
        assert(withoutResource(before) === withoutResource(after), 'Resource edit changed unrelated rules');
        const actual = (await browser.scripting.executeScript({ target: { tabId },
          func: async () => (await fetch('http://popup-cdn.test:' + location.port + '/multiproxy-popup-selected-B-' + Date.now(), { cache: 'no-store' })).text() }))[0].result;
        assert(actual === 'second-proxy', 'Popup-selected resource must actually use proxy B, got ' + actual);
        await report({ stage: 'multiproxy-popup-resource', actual, exactHostOnly: true });
        rowSelect().value = '@direct';
        rowSelect().dispatchEvent(new Event('change', { bubbles: true }));
        await wait(async () => (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions[host] === false);
        await wait(() => rowSelect()?.value === '@direct' && !rowSelect().disabled);
        assert(rowSelect().selectedOptions[0].textContent === chrome.i18n.getMessage('popupWithoutProxy'), 'Direct label must use the native locale');
        const manualHost = 'manual.route-a.test';
        await send({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: manualHost, mode: 'proxy', proxyId: b }] });
        const probeHost = async (host, expected) => {
          const value = (await browser.scripting.executeScript({ target: { tabId },
            args: [host], func: async host => (await fetch(`http://${host}:${location.port}/multiproxy-popup-site-${Date.now()}`,
              { cache: 'no-store' })).text() }))[0].result;
          assert(value === expected, `Site inheritance ${host}: ${value} !== ${expected}`);
        };
        const chooseSite = async id => {
          const latest = (await send({ action: 'GET_EXCEPTIONS' })).data;
          await wait(() => Number(document.querySelector('.site-proxy')?.dataset.rulesRevision) === latest.revision &&
            !document.querySelector('.site-proxy').disabled);
          const select = document.querySelector('.site-proxy');
          select.value = id;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          await wait(async () => (await send({ action: 'GET_EXCEPTIONS' })).data.domainProxyIds['route-a.test'] === id);
          await wait(() => document.querySelector('.site-proxy')?.value === id && document.body.getAttribute('aria-busy') === 'false');
        };
        await probeHost(manualHost, 'second-proxy');
        await probeHost(host, 'origin-direct');
        await chooseSite(b);
        await probeHost('route-a.test', 'second-proxy');
        await probeHost('unassigned.popup-inherit.test', 'second-proxy');
        await probeHost('late.popup-inherit.test', 'second-proxy');
        await chooseSite(a);
        await probeHost('unassigned.popup-inherit.test', 'own-proxy');
        await probeHost('late.popup-inherit.test', 'own-proxy');
        await probeHost(manualHost, 'second-proxy');
        await probeHost(host, 'origin-direct');
        const finalRules = (await send({ action: 'GET_EXCEPTIONS' })).data;
        assert(finalRules.domainProxyIds[manualHost] === b && finalRules.exceptions[host] === false &&
          !Object.hasOwn(finalRules.domainProxyIds, host), 'Site selection overwrote a manual resource proxy or Direct rule');
        assert(finalRules.defaultProxyId === before.defaultProxyId, 'Site selection changed the catalog default');
        assert(get('actionScope').hidden && get('source').hidden && get('scope').hidden && get('notice').hidden, 'Routine explanations must be hidden');
        assert(Boolean(get('route').title), 'Main route must expose explanation on hover');
        assert(parseFloat(getComputedStyle(get('resources')).paddingRight) >= 10, 'Resource controls touch the scrollbar');
        await report({ stage: 'multiproxy-popup-site', inherited: 'A-B-A', manualResources: 'B/DIRECT', defaultUnchanged: true });
        await report({ stage: 'multiproxy-popup-direct', actual: 'origin-direct', manualDirectPreserved: true });
        const wildcardHost = 'wild.route-a.test';
        await send({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: '*.route-a.test', mode: 'proxy', proxyId: b }] });
        await probeHost(wildcardHost, 'second-proxy');
        const setInheritance = async value => {
          const latest = (await send({ action: 'GET_EXCEPTIONS' })).data;
          await wait(() => Number(document.querySelector('.site-proxy')?.dataset.rulesRevision) === latest.revision && !get('inheritResources').disabled);
          assert(get('inheritResources').checked !== value, 'Inheritance fixture must really toggle the setting');
          get(value ? 'inheritResources' : 'directResources').click();
          try { await wait(() => get('inheritResources').checked === value && !get('inheritResources').disabled && document.body.getAttribute('aria-busy') === 'false'); }
          catch (error) { throw new Error(error.message + ': ' + get('notice').textContent); }
        };
        await setInheritance(false);
        await probeHost('route-a.test', 'own-proxy');
        await probeHost('unassigned.popup-inherit.test', 'origin-direct');
        await probeHost('late.popup-inherit.test', 'origin-direct');
        await probeHost('off.popup-inherit.test', 'origin-direct');
        await probeHost(wildcardHost, 'second-proxy');
        await chooseSite(b);
        await probeHost('unassigned.popup-inherit.test', 'origin-direct');
        get('siteRoute').value = '@direct';
        get('siteRoute').dispatchEvent(new Event('change', { bubbles: true }));
        await wait(async () => (await send({ action: 'GET_EXCEPTIONS' })).data.exceptions['route-a.test'] === false);
        await wait(() => document.body.getAttribute('aria-busy') === 'false');
        await probeHost('route-a.test', 'origin-direct');
        await probeHost(wildcardHost, 'second-proxy');
        await probeHost(manualHost, 'second-proxy');
        await probeHost(host, 'origin-direct');
        await chooseSite(a);
        await setInheritance(true);
        await probeHost('unassigned.popup-inherit.test', 'own-proxy');
        await probeHost('off.popup-inherit.test', 'own-proxy');
        const policyRules = (await send({ action: 'GET_EXCEPTIONS' })).data;
        assert(policyRules.domainProxyIds['*.route-a.test'] === b && !Object.hasOwn(policyRules.exceptions, wildcardHost), 'Manual wildcard must remain independent, without an automatic exact shadow');
        assert(policyRules.defaultProxyId === before.defaultProxyId, 'Inheritance changed default proxy');
        await report({ stage: 'multiproxy-popup-inheritance', automatic: 'A-DIRECT-A', manual: 'B/DIRECT/wildcard-B', mainDirectPreserved: true });
        const chooseResource = async (resource, value) => {
          const latest = (await send({ action: 'GET_EXCEPTIONS' })).data;
          await wait(() => Number(document.querySelector('.site-proxy')?.dataset.rulesRevision) === latest.revision);
          const selector = `#resources select[data-host="${resource}"]`;
          await wait(() => document.querySelector(selector) && !document.querySelector(selector).disabled);
          const input = document.querySelector(selector);
          assert([...input.options].some(option => option.value === value && !option.disabled), 'Resource action not offered: ' + value);
          input.value = value;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await wait(() => document.body.getAttribute('aria-busy') === 'false');
          assert(get('notice').hidden, get('notice').textContent);
          return document.querySelector(selector);
        };
        let selected = await chooseResource(host, '@reset-exact');
        assert(selected.value === '@automatic', 'Reset exposes Automatic before choosing the same effective profile');
        selected = await chooseResource(host, a);
        assert(selected.closest('li').dataset.origin === 'manual' && selected.closest('li').querySelector('.resource-manual'), 'A manual assignment to the parent profile must remain pinned');
        selected = await chooseResource(host, '@reset-exact');
        assert(selected.value === '@automatic' && selected.closest('li').dataset.origin === 'site' && !selected.closest('li').querySelector('.resource-manual'), 'Exact reset should return this resource to the site policy');
        await probeHost(host, 'own-proxy');
        await report({ stage: 'resource-ux-reset-to-site' });
        await chooseResource(wildcardHost, '@direct');
        await probeHost(wildcardHost, 'origin-direct');
        selected = await chooseResource(wildcardHost, '@reset-exact');
        await probeHost(wildcardHost, 'second-proxy');
        assert(selected.closest('li').dataset.origin === 'manual' && ![...selected.options].some(option => option.value === '@reset-exact'), 'A remaining manual wildcard must remain visible and cannot be reset as an exact rule');
        const afterReset = (await send({ action: 'GET_EXCEPTIONS' })).data;
        assert(afterReset.domainProxyIds['*.route-a.test'] === b && !Object.hasOwn(afterReset.exceptions, wildcardHost), 'Reset changed the wildcard or retained an exact override');
        await report({ stage: 'resource-ux-reset-to-wildcard' });
        await setInheritance(false);
        await chooseResource(host, b);
        await chooseResource(host, '@reset-exact');
        await probeHost(host, 'origin-direct');
        await report({ stage: 'resource-ux-reset-to-direct' });
        await setInheritance(true);
        await probeHost(host, 'own-proxy');
        await report({ stage: 'resource-ux-before-reload' });
        assert(!get('reload').hidden && !get('reload').disabled, 'Reload must be a visible enabled action');
        // The real action closes this popup. Its background fixture registers
        // navigation/close observers before acknowledging this handshake.
        await browser.runtime.sendMessage({ resourceProxyPopupReload: true });
        get('reload').click();
        return;
      } catch (error) {
        await browser.runtime.sendMessage({ resourceProxyPopupDone: true, error: error.message });
      }
      window.close();
      return;
    }
    if (get('permissionStatus')) {
      await wait(() => get('permissionStatus').classList.contains('denied'));
      const locale = (requestedLocale || 'ru').startsWith('en') ? 'en' : 'ru';
      const message = key => chrome.i18n.getMessage(key);
      assert(message('uiLanguage') === locale, 'Private-window setup must use the requested native catalog');
      assert(document.documentElement.lang.startsWith(locale), 'Private-window document language mismatch');
      assert(document.title === message('firefoxPermissionTitle'), 'Private-window title was not localized');
      assert(document.querySelector('h1').textContent === message('firefoxPermissionHeading'), 'Private-window heading was not localized');
      assert(get('permissionStatus').textContent === message('firefoxPermissionDenied'), 'Denied status was not localized');
      assert(document.querySelector('ol').textContent.includes(message('firefoxPermissionStepPrivate')), 'Firefox instructions were not localized');
      await report({ uiDone: true, locale, privatePermissionDenied: true });
      return;
    }
    // Firefox does not expose extension contexts to BiDi viewport emulation.
    // Render the real packaged options page in a same-origin 900×600 frame;
    // it retains the real extension APIs, CSP, storage and background.
    if (!get('modeSwitch') && !window.frameElement) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;inset:0;width:900px;height:600px;border:0;z-index:9999;background:var(--bg-primary)';
      frame.src = location.href;
      document.body.append(frame);
      return;
    }
    if (get('modeSwitch')) {
      await wait(() => get('domain').textContent === 'proxy.test');
      const expected = requestedLocale.startsWith('en') ? 'en' : 'ru';
      assert(chrome.i18n.getMessage('uiLanguage') === expected, 'Native popup locale mismatch');
      assert(document.documentElement.lang.split('-')[0] === expected, 'Popup document language mismatch');
      assert(get('siteRoute').querySelector('option[value="@direct"]').textContent.trim() === chrome.i18n.getMessage('popupWithoutProxy'), 'Popup mode label is not localized');
      const resourceLabel = document.querySelector('#resourceDetails summary [data-i18n]').getBoundingClientRect();
      const resourceCount = get('resourceCount').getBoundingClientRect();
      assert(resourceCount.left - resourceLabel.right >= 8, 'Resource count must be separated from its label');
      const settingsLabel = document.querySelector('.settings-label').getBoundingClientRect();
      const settingsArrow = document.querySelector('.settings-arrow').getBoundingClientRect();
      assert(Math.abs(settingsArrow.left - settingsLabel.right - 6) <= 0.1, 'Settings arrow gap must match design 01 (6px)');
      const arrowInset = document.querySelector('.settings').getBoundingClientRect().right - settingsArrow.right;
      assert(arrowInset >= 0 && arrowInset <= 12, 'Settings arrow must align with the right edge');
      assert(get('actionScope').textContent.includes(chrome.i18n.getMessage('msg_for_the_whole_tab_the_page_videos_images_and__3ce1328f')), 'Popup must explain whole-tab routing');
      const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      const probe = async () => (await browser.scripting.executeScript({ target: { tabId: tab.id },
        func: async () => (await fetch('http://cdn.test:' + location.port + '/popup-probe')).text() }))[0].result;
      for (const [mode, expected] of [['proxy', 'own-proxy'], ['direct', 'origin-direct'], ['pac', 'own-proxy']]) {
        const select = get('siteRoute');
        const value = mode === 'proxy' ? [...select.options].find(option => !option.disabled && !option.value.startsWith('@'))?.value : '@' + mode;
        assert(value, 'Proxy fixture must expose an enabled named profile');
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(() => !get('siteRoute').disabled && get('siteRoute').value === value && document.body.getAttribute('aria-busy') === 'false');
        assert(await probe() === expected, `Firefox popup ${mode} resource route failed`);
        const badge = { proxy: 'P', direct: 'D', pac: 'PAC' }[mode];
        await wait(async () => await browser.action.getBadgeText({ tabId: tab.id }) === badge);
        assert((await browser.action.getTitle({ tabId: tab.id })).includes(chrome.i18n.getMessage('badgeModeHint')),
          'Firefox badge must explain the selected mode');
      }
      await send({ action: 'SAVE_MODS', mods: { ifProxyHttpsUrlsOnly: true } });
      await wait(() => get('actionScope').textContent.includes(chrome.i18n.getMessage('msg_restrictions_sub_requests_outside_these_restr_190f99dc', ['HTTPS']).split('HTTPS')[1].trim()));
      assert(await probe() === 'origin-direct', 'Popup HTTPS restriction explanation must match actual routing');
      await report({ uiDone: true, locale: expected, popup: 'proxy/direct/PAC resources and restrictions verified' });
      return;
    }
    await wait(() => get('extVersion').textContent && document.querySelector('#tab-pac.active'));
    const expected = requestedLocale.startsWith('en') ? 'en' : 'ru';
    assert(chrome.i18n.getMessage('uiLanguage') === expected, 'Native settings locale mismatch');
    assert(document.title === (expected === 'en' ? 'Unroute — Settings' : 'Unroute — Настройки'), 'Settings title is not localized');
    assert(document.querySelector('nav').getAttribute('aria-label') === (expected === 'en' ? 'Settings sections' : 'Разделы настроек'), 'Accessible navigation label is not localized');
    const substituted = chrome.i18n.getMessage('msg_port_sub_is_outside_the_valid_range_1_65535_d383d658', ['70000']);
    assert(substituted.includes('70000') && !substituted.includes('$'), 'Native named substitution failed');
    const fits = name => {
      assert(document.documentElement.scrollWidth <= innerWidth, `${name}: horizontal overflow`);
      // 01 is a normal document, not the former viewport-height app shell.
      // Longer real settings may scroll, but must never clip their footer.
      const footer = document.querySelector('.statusbar');
      assert(footer.getBoundingClientRect().bottom <= document.body.getBoundingClientRect().bottom + 1, `${name}: footer outside settings`);
      assert(getComputedStyle(document.documentElement).overflowY !== 'hidden' && getComputedStyle(document.body).overflowY !== 'hidden', `${name}: page scrolling blocked`);
      const scrolling = document.scrollingElement, previous = scrolling.scrollTop;
      scrolling.scrollTop = scrolling.scrollHeight;
      assert(footer.getBoundingClientRect().bottom <= innerHeight + 1, `${name}: footer unreachable by scrolling`);
      scrolling.scrollTop = previous;
    };
    fits('PAC');
    // Run in the real Firefox extension document (not BiDi's inaccessible contexts).
    const originalAppearance = (await browser.storage.local.get('ui-appearance'))['ui-appearance'];
    const rulesBeforeAppearance = (await browser.storage.local.get('pac-kitchen-mods'))['pac-kitchen-mods'];
    document.querySelector('[data-tab="appearance"]').click();
    await wait(() => get('appearanceTheme'));
    for (const theme of ['dark', 'light']) {
      get('appearanceTheme').value = theme;
      get('appearanceTheme').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => document.documentElement.dataset.theme === theme);
      for (const accent of ['mint', 'blue', 'sage']) {
        document.querySelector(`[data-accent="${accent}"]`).click();
        await wait(async () => (await browser.storage.local.get('ui-appearance'))['ui-appearance']?.accent === accent);
      }
      fits(`Appearance/${theme}`);
      assert(getComputedStyle(document.querySelector('.brand-logo')).filter === 'none', 'Appearance must not recolor the fixed icon');
      await wait(() => window.parent.document.documentElement.dataset.theme === theme);
    }
    assert(JSON.stringify((await browser.storage.local.get('pac-kitchen-mods'))['pac-kitchen-mods']) === JSON.stringify(rulesBeforeAppearance), 'Appearance must not write PAC settings');
    if (originalAppearance) await browser.storage.local.set({ 'ui-appearance': originalAppearance });
    else await browser.storage.local.remove('ui-appearance');
    document.querySelector('[data-tab="pac"]').click();
    document.querySelector('[data-tab="proxies"]').click();
    fits('Proxies');
    const tops = [...document.querySelectorAll('.proxy-endpoint-fields .form-group')].map(node => node.getBoundingClientRect().top);
    assert(Math.max(...tops) - Math.min(...tops) < 1, 'Proxy fields must share a row');
    assert(!get('proxyAdvanced').open, 'Advanced controls start collapsed');
    get('proxyHost').value = '127.0.0.1';
    get('proxyPort').value = ownProxy.split(':').at(-1);
    get('addProxyBtn').click();
    await wait(() => !get('addProxyBtn').disabled && (get('proxyFormAlert').style.display === 'flex' ||
      [...get('proxyCardsList').querySelectorAll('.proxy-item')]
        .some(item => item.querySelector('.proxy-addr').textContent.startsWith('127.0.0.1:') && item.querySelector('.proxy-status-tag.online'))));
    if (get('proxyFormAlert').style.display === 'flex') {
      await report({ stage: 'proxy-add-failure', logs: (await send({ action: 'GET_LOGS', category: 'proxy' })).data.logs.slice(0, 2) });
      throw new Error('Proxy add failed: ' + get('proxyFormAlertText').textContent);
    }
    assert((await send({ action: 'GET_STATE' })).data.proxyHealthMap[ownProxy]?.ok,
      'Added proxy health must survive a state reload');
    assert((await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: ownProxy } })).success, 'Restore proxy list after add test');
    try {
      const image = await browser.tabs.captureVisibleTab(null, { format: 'png' });
      await report({ stage: 'ui-screenshot', image });
    } catch { /* Capture permission may differ; DOM assertions remain required. */ }
    get('proxyHost').value = 'draft.example.test';
    get('proxyAuthCheck').click();
    get('proxyUser').value = 'draft-user';
    get('proxyEditorModeToggle').click();
    const savedRaw = get('customProxyText').value;
    get('customProxyText').focus();
    const changedRaw = [savedRaw, 'HTTPS secondary-ui.test:443'].filter(Boolean).join('\n');
    await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: changedRaw } });
    await wait(() => get('customProxyText').value === changedRaw);
    await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: savedRaw } });
    await wait(() => get('customProxyText').value === savedRaw);
    get('proxyEditorModeToggle').click();
    assert(get('proxyHost').value === 'draft.example.test' && get('proxyUser').value === 'draft-user', 'Form drafts were lost');
    get('proxyEditorModeToggle').click();
    get('customProxyText').value = 'HTTP draft.example.test:8123';
    get('customProxyText').dispatchEvent(new Event('input', { bubbles: true }));
    get('proxyEditorModeToggle').click();
    get('proxyEditorModeToggle').click();
    assert(get('customProxyText').value === 'HTTP draft.example.test:8123', 'Text draft was lost across mode switch');
    await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: changedRaw } });
    await wait(() => get('proxyDraftHint').textContent.includes(chrome.i18n.getMessage('msg_the_saved_list_has_changed_your_draft_has_not_36e48c20')));
    assert(get('customProxyText').value === 'HTTP draft.example.test:8123', 'Dirty draft was overwritten by external proxy change');
    await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: savedRaw } });
    get('proxyEditorModeToggle').click();
    const before = (await send({ action: 'GET_STATE' })).data.pacMods.ifUseOwnProxiesOnlyForOwnSites;
    assert((await send({ action: 'SAVE_MODS', mods: { ifUseOwnProxiesOnlyForOwnSites: true } })).success, 'Preference save failed');
    await wait(() => get('proxyAdvancedState').textContent.length > 0);
    assert(get('customProxyText').value === 'HTTP draft.example.test:8123', 'External update overwrote a dirty proxy list');
    assert(get('proxyAdvancedState').getBoundingClientRect().height > 0, 'Enabled limit must remain visible when collapsed');
    assert((await send({ action: 'SAVE_MODS', mods: { ifUseOwnProxiesOnlyForOwnSites: before,
      customProxyStringRaw: ownProxy, ifUseSecureProxiesOnly: false } })).success, 'Own proxy setup failed');
    const sitesChecks = await checkSitesEditor();
    document.querySelector('[data-tab="pac"]').click();
    const settingsTab = await browser.tabs.getCurrent();
    await browser.tabs.update(settingsTab.id, { active: true });
    const domainLists = await checkDomainListsNative({ ...networkConfig, pacExpected: 'own-proxy', probe: async (host, label, resource, route) => {
      const url = `http://${host}:${networkConfig.port}/domain-lists-${label}-${Date.now()}`;
      const tab = await browser.tabs.create({ url, active: false });
      try {
        await wait(async () => { const current = await browser.tabs.get(tab.id); return current.status === 'complete' && current.url === url; });
        if (route) {
          const snapshot = await send({ action: 'GET_DOMAIN_LISTS' });
          const result = await send({ action: 'SET_SITE_ROUTE', ...route, currentTabId: tab.id, expectedHost: host,
            expectedRevision: snapshot.data.revision });
          assert(result.success, 'Domain list manual root override: ' + JSON.stringify(result));
          await browser.tabs.update(tab.id, { url: url + '-after-manual' });
          await wait(async () => { const current = await browser.tabs.get(tab.id); return current.status === 'complete' && current.url === url + '-after-manual'; });
        }
        return (await browser.scripting.executeScript({ target: { tabId: tab.id }, args: [resource, label],
          func: async (resource, label) => resource
            ? (await fetch(`http://native-list-cdn.test:${location.port}/domain-lists-${label}-resource-${Date.now()}`, { cache: 'no-store' })).text()
            : document.body.textContent }))[0].result;
      } finally { await browser.tabs.remove(tab.id); await browser.tabs.update(settingsTab.id, { active: true }); }
    }});
    await report({ stage: 'domain-lists-native-pass', locale: requestedLocale, proofs: domainLists });
    const limitsHelp = await checkLimitsAndHelp();
    const webTab = (await browser.tabs.query({})).find(tab => tab.url?.startsWith('http://proxy.test:'));
    assert(webTab, 'Popup fixture tab is missing');
    await browser.tabs.update(webTab.id, { active: true });
    await browser.tabs.create({ url: browser.runtime.getURL('pages/popup/index.html'), active: false });
    await report({ stage: 'ui-settings', size: `${innerWidth}x${innerHeight}`, checks: 'PAC/proxy layout, drafts, collapsed enabled hint; Sites: ' + sitesChecks + '; Limits/help: ' + limitsHelp });
  } catch (error) { await report({ uiDone: true, error: error.message, stack: error.stack, ...(networkConfig?.failoverOnly ? { proofs: failoverProofs } : {}) }); }
}
