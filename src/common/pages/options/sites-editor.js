'use strict';

import { t, uiLocale } from '../../core/i18n.js';
import { refreshSettingsHelp } from './settings-help.js';
import { normalizeDomainRule, parseDomainRuleLines, toggleWildcardDomain, toggleWildcardLines } from '../../core/domain-rules.js';
import { sendMessage } from '../shared/client.js';
import { ruleSourceLabel } from '../shared/rule-source.js';
import { createDomainCardIndex } from './domain-cards-list.js';
import { initDomainListsEditor, confirmListAction } from './domain-lists-editor.js';
import { readListFile, readManualDomainFile, listPreviewText, parseListText, domainListExportFilename } from './domain-file-io.js';

export function initSitesEditor(root, options) {
  return initDomainListsEditor(root, options, initDomainEditor);
}

function initDomainEditor(element, { notify, onApplicationState, navigate, listId = null }) {
  const prefix = element.dataset.idPrefix || '';
  const selector = value => value.replace(/#([\w-]+)/g, (_match, id) => '#' + prefix + id);
  const root = {
    querySelector: value => element.querySelector(selector(value)),
    querySelectorAll: value => element.querySelectorAll(selector(value)),
  };
  const scoped = Boolean(listId);
  let listDomains = [];
  const readRequest = () => scoped ? {action:'GET_DOMAIN_LIST',listId} : {action:'GET_EXCEPTIONS'};
  const validResponse = response => Boolean(response?.success && response.data && (!scoped ||
    (response.data.list?.id === listId && Array.isArray(response.data.list.domains) && Number.isSafeInteger(response.data.revision))));
  const snapshot = data => scoped ? {...data,exceptions:Object.fromEntries((data.list?.domains || []).map(domain=>[domain,true])),whitelist:[],ruleMeta:{},domainProxyIds:{}} : data;
  const showToast = notify;
  const manualRawHelp = root.querySelector('.editor-help-card').textContent;
  let state = {
    exceptions: {},
    whitelist: [],
    pacBypassDomains: [],
    activeSubTab: 'included', // 'included' | 'excluded' | 'whitelist'
    rawMode: false,
    ruleMeta: {},
    proxyCatalog: [],
    domainProxyIds: {},
    defaultProxyId: null,
  };
  let saveQueue = Promise.resolve();
  const selectedDomains = new Set();
  let rawConflict = false;
  let rawAutosaveTimer = null;
  let rawEditRevision = 0;
  let rawEditorDirty = false;
  let loaded = false;
  let loadRevision = 0;
  let pendingSaves = 0;
  let dataRevision = null;
  let loadFailed = false;
  let resetGeneration = 0;
  const RAW_AUTOSAVE_DELAY_MS = 600;

  const el = {
    listViewSection: root.querySelector('#listViewSection'),
    editorViewSection: root.querySelector('#editorViewSection'),
    importFileBtn: root.querySelector('#importFileBtn'),
    exportFileBtn: root.querySelector('#exportFileBtn'),
    fileImportInput: root.querySelector('#fileImportInput'),
    modeToggleBtn: root.querySelector('#modeToggleBtn'),
    saveStatusText: root.querySelector('#saveStatusText'),
    tabBtns: root.querySelectorAll('.tab-btn'),
    includedCount: root.querySelector('#includedCount'),
    excludedCount: root.querySelector('#excludedCount'),
    whitelistCount: root.querySelector('#whitelistCount'),
    newDomainInput: root.querySelector('#newDomainInput'),
    addDomainBtn: root.querySelector('#addDomainBtn'),
    searchDomainInput: root.querySelector('#searchDomainInput'),
    clearListBtn: root.querySelector('#clearListBtn'),
    domainListContainer: root.querySelector('#domainListContainer'),
    rawTextEditor: root.querySelector('#rawTextEditor'),
    editorStatusText: root.querySelector('#editorStatusText'),
    retrySitesLoad: root.querySelector('#retrySitesLoad'),
    sourceFilter: root.querySelector('#sourceFilter'),
    newRuleProxy: root.querySelector('#newRuleProxy'),
    newRuleProxyRow: root.querySelector('#newRuleProxyRow'),
    proxyFilter: root.querySelector('#proxyFilter'),
    bulkProxy: root.querySelector('#bulkProxy'),
    bulkAssign: root.querySelector('#bulkAssign'),
    selectionToolbar: root.querySelector('#selectionToolbar'),
    selectionCount: root.querySelector('#selectionCount'),
    selectAllFiltered: root.querySelector('#selectAllFiltered'),
    clearSelection: root.querySelector('#clearSelection'),
    rawRetrySave: root.querySelector('#rawRetrySave'),
    pacCount: root.querySelector('#pacCount'),
    bulkDelete: root.querySelector('#bulkDelete'),
    bulkWildcardBtn: root.querySelector('#bulkWildcardBtn'),
    rawWildcardBtn: root.querySelector('#rawWildcardBtn'),
  };

  // Native textarea remains the only editable surface. The inert backdrop paints
  // line backgrounds only; untrusted input is never interpreted as markup.
  const rawFrame = document.createElement('div'); rawFrame.className = 'raw-editor-frame';
  const rawBackdrop = document.createElement('div'); rawBackdrop.className = 'raw-highlight-backdrop';
  rawBackdrop.setAttribute('aria-hidden', 'true');
  const rawHighlights = document.createElement('pre'); rawHighlights.className = 'raw-highlight-content';
  rawBackdrop.append(rawHighlights);
  el.rawTextEditor.before(rawFrame); rawFrame.append(rawBackdrop, el.rawTextEditor);
  el.rawTextEditor.wrap = 'off';
  el.rawTextEditor.setAttribute('aria-invalid', 'false');
  el.rawTextEditor.setAttribute('aria-describedby', el.editorStatusText.id);
  el.editorStatusText.setAttribute('role', 'status');
  el.editorStatusText.setAttribute('aria-live', 'polite');

  let rawInvalidLines = new Set();

  function syncRawScroll() {
    const text = el.rawTextEditor;
    const style = getComputedStyle(text);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
    const first = Math.max(1, Math.floor(text.scrollTop / lineHeight) - 1);
    const last = Math.ceil((text.scrollTop + text.clientHeight) / lineHeight) + 2;
    const fragment = document.createDocumentFragment();
    // Only erroneous rows near the viewport have DOM nodes, even for 100k errors.
    for (let number = first; number <= last; number++) {
      if (!rawInvalidLines.has(number)) continue;
      const line = document.createElement('span');
      line.className = 'raw-line-error'; line.dataset.line = String(number);
      line.style.top = `${parseFloat(style.paddingTop) + (number - 1) * lineHeight}px`;
      line.style.height = `${lineHeight}px`;
      fragment.append(line);
    }
    rawHighlights.replaceChildren(fragment);
    rawHighlights.style.width = `${text.scrollWidth}px`;
    rawHighlights.style.transform = `translate(${-text.scrollLeft}px, ${-text.scrollTop}px)`;
  }

  function validateRawText() {
    el.rawTextEditor.setAttribute('aria-busy', 'false');
    let parsed;
    try { parsed = parseListText(el.rawTextEditor.value); }
    catch (cause) {
      rawInvalidLines.clear(); syncRawScroll();
      el.rawTextEditor.setAttribute('aria-invalid', 'true');
      el.rawRetrySave.hidden = true;
      el.editorStatusText.textContent = cause.message; return null;
    }
    rawInvalidLines = new Set(parsed.errors.map(row => row.line));
    syncRawScroll();
    el.rawTextEditor.setAttribute('aria-invalid', String(rawInvalidLines.size > 0));
    if (rawInvalidLines.size) {
      const reference = parsed.errors.find(row => row.code === 'UNSUPPORTED_INCLUDE');
      el.editorStatusText.textContent = t('dlRawInvalid', 'Не сохранено. Ошибочных строк: $1 (первая: $2). Исправьте подсвеченные строки.', [rawInvalidLines.size, parsed.errors[0].line])
        + (reference ? ' ' + reference.error : '');
      el.rawRetrySave.hidden = true;
    } else {
      el.rawRetrySave.hidden = !rawConflict && !loadFailed;
    }
    return parsed;
  }

  function setSaveStatus(kind, text) {
    if (!el.saveStatusText) return;
    el.saveStatusText.className = `autosave-status ${kind}`;
    el.saveStatusText.textContent = text;
  }

  async function loadData() {
    if (rawEditorDirty || pendingSaves) return;
    const revision = ++loadRevision;
    const res = await sendMessage({ ...readRequest(), ...(scoped ? {} : {knownRevision:dataRevision}) });
    if (revision !== loadRevision || rawEditorDirty || pendingSaves) return;
    if (validResponse(res)) {
      const mods = snapshot(res.data);

      el.retrySitesLoad.hidden = true;
      if (loadFailed) setSaveStatus('saved', t("msg_autosave_c04c99b6", "✓ Автосохранение"));
      loadFailed = false;
      const catalogChanged = updateCatalog(mods);
      onApplicationState(res.settingsState);
      if (mods.unchanged && loaded) { if (catalogChanged) render(); renderBusy(); return; }
      applySnapshot(mods);
      loaded = true;
      setControlsEnabled(true);
      el.importFileBtn.disabled = state.rawMode;
      el.exportFileBtn.disabled = state.rawMode;
      el.retrySitesLoad.hidden = true;
      render();
      if (state.rawMode) fillRawEditor();
    } else {
      loadFailed = true;
      setControlsEnabled(false);
      setSaveStatus('error', t("msg_load_failed_5263d105", "⚠ Ошибка загрузки"));
      showToast(t("msg_failed_to_load_data_de4395f1", "Ошибка загрузки данных"));
      el.retrySitesLoad.hidden = false;
    }
  }

  function setControlsEnabled(enabled) {
    root.querySelectorAll('input, select, textarea, button:not(#retrySitesLoad):not(#openHistoryBtn)')
      .forEach(control => { control.disabled = !enabled; });
  }

  function updateCatalog(data) {
    const catalog = Array.isArray(data.proxyCatalog) ? data.proxyCatalog : state.proxyCatalog;
    const defaultId = data.defaultProxyId ?? null;
    if (defaultId === state.defaultProxyId && JSON.stringify(catalog) === JSON.stringify(state.proxyCatalog)) return false;
    state.proxyCatalog = catalog;
    proxySelectTemplate = null;
    state.defaultProxyId = defaultId;
    const previous = el.newRuleProxy.value;
    const eligible = state.proxyCatalog.filter(proxy => proxy.enabled);
    fillTargets(el.newRuleProxy, eligible, previous || state.defaultProxyId);
    fillTargets(el.bulkProxy, eligible, el.bulkProxy.value);
    const filter = el.proxyFilter.value;
    el.proxyFilter.replaceChildren(new Option(t('mpAllProxies', 'Все прокси'), ''),
      new Option(t('mpLegacy', 'Общая цепочка (без назначения)'), 'legacy'));
    for (const proxy of state.proxyCatalog) el.proxyFilter.add(new Option(proxy.name, proxy.id));
    el.proxyFilter.value = [...el.proxyFilter.options].some(option => option.value === filter) ? filter : '';
    return true;
  }

  function fillTargets(select, catalog, value, includeLegacy = false) {
    select.replaceChildren();
    if (includeLegacy || !catalog.length) select.add(new Option(t('mpLegacy', 'Общая цепочка (без назначения)'), ''));
    for (const proxy of catalog) {
      const option = new Option(proxy.name, proxy.id);
      option.disabled = !proxy.enabled;
      select.add(option);
    }
    if ([...select.options].some(option => option.value === value)) select.value = value;
  }

  function applySnapshot(data) {
    if (scoped) listDomains = [...(data.list?.domains || [])];
    state.exceptions = { ...(data.exceptions || {}) };
    state.whitelist = [...(data.whitelist || [])];
    state.pacBypassDomains = [...(data.pacBypassDomains || [])];
    state.ruleMeta = data.ruleMeta || {};
    state.domainProxyIds = data.domainProxyIds || {};
    cardIndex = createDomainCardIndex(state);
    dataRevision = Number.isSafeInteger(data.revision) ? data.revision : null;
    for (const domain of selectedDomains) if (state.exceptions[domain] !== true) selectedDomains.delete(domain);
  }

  // Writes are serialized, never optimistic full-list replacements. Failed writes
  // retain the input/selection; acknowledgements are read back before rendering.
  function commit(messageFactory, { raw = false } = {}) {
    if (!loaded || loadFailed) return Promise.resolve(false);
    ++pendingSaves;
    ++loadRevision;
    const generation = resetGeneration;
    const message = messageFactory();
    const displayedRevision = message.expectedRevision;
    setSaveStatus('saving', t('msg_saving_057ec605', '⏳ Сохранение…'));
    const run = async () => {
      if (generation !== resetGeneration) return false;
      try {
        const res = await sendMessage(scoped ? {...message,listId,expectedRevision:displayedRevision} : message);
        if (generation !== resetGeneration) return false;
        onApplicationState(res?.settingsState);
        if (!res?.success) {
          if (scoped) loadFailed = true;
          if (!raw) el.retrySitesLoad.hidden = false;
          if (raw) {
            rawConflict = (res.error?.code || res.errorCode) === 'RULES_CONFLICT';
            el.rawRetrySave.hidden = false;
            el.editorStatusText.textContent = t('mpRawConflict', 'Текст сохранён в черновике. Обновите данные и повторите сохранение.');
          }
          showToast(res?.error?.message || res?.error || t('msg_failed_4bdba3ac', 'Сбой'));
          setSaveStatus('error', t('msg_error_fd89ce15', '⚠ Ошибка'));
          return false;
        }
        const updated = await sendMessage(readRequest());
        if (generation !== resetGeneration) return false;
        if (!validResponse(updated)) {
          loadFailed = true;
          if (raw) { rawConflict = true; el.rawRetrySave.hidden = false; }
          setSaveStatus('error', t('mpReadbackFailed', 'Сохранено · обновите данные'));
          el.retrySitesLoad.hidden = false;
          return false;
        }
        updateCatalog(updated.data);
        applySnapshot(snapshot(updated.data));
        onApplicationState(updated.settingsState);
        rawConflict = false;
        el.rawRetrySave.hidden = true;
        render();
        setSaveStatus(res.settingsState?.pending ? 'error' : 'saved', res.settingsState?.pending
          ? t('msg_saved_waiting_to_apply_cee8b842', 'Сохранено · ожидает применения') : t('msg_saved_6c67d096', '✓ Сохранено'));
        return res;
      } catch (error) {
        if (generation !== resetGeneration) return false;
        if (scoped) loadFailed = true;
        setSaveStatus('error', t('msg_error_fd89ce15', '⚠ Ошибка'));
        showToast(error.message);
        if (raw) { rawConflict = false; el.rawRetrySave.hidden = false; }
        else el.retrySitesLoad.hidden = false;
        return false;
      }
    };
    const result = saveQueue.then(run, run).finally(() => { --pendingSaves; renderBusy(); });
    saveQueue = result.then(() => undefined);
    renderBusy();
    return result;
  }

  function renderBusy() {
    setControlsEnabled(loaded && !loadFailed && !pendingSaves);
    // Keep typing available while the previous raw save is acknowledged.
    el.rawTextEditor.disabled = !loaded;
    if (el.rawWildcardBtn) el.rawWildcardBtn.disabled = !loaded;
    el.rawRetrySave.disabled = !loaded || Boolean(pendingSaves);
    el.importFileBtn.disabled = !loaded || loadFailed || Boolean(pendingSaves) || state.rawMode;
    el.exportFileBtn.disabled = !loaded || loadFailed || Boolean(pendingSaves) || state.rawMode;
    el.bulkAssign.disabled = Boolean(pendingSaves) || !selectedDomains.size || !el.bulkProxy.value;
    if (el.bulkWildcardBtn) el.bulkWildcardBtn.disabled = !loaded || loadFailed || Boolean(pendingSaves) || !selectedDomains.size;
    if (el.bulkDelete) el.bulkDelete.disabled = !loaded || loadFailed || Boolean(pendingSaves) || !selectedDomains.size;
    if (scoped) {
      el.newRuleProxyRow.hidden = true; el.proxyFilter.hidden = true; el.sourceFilter.hidden = true;
      el.bulkProxy.hidden = true; el.bulkAssign.hidden = true;
    }
  }

  function mutate(operations, revision = dataRevision) {
    if (scoped) {
      const domains = new Set(listDomains);
      for (const operation of operations) {
        if (operation.mode === 'proxy') domains.add(operation.domain);
        else domains.delete(operation.domain);
      }
      return commit(() => ({action:'SAVE_DOMAIN_LIST',listId,domains:[...domains],expectedRevision:revision}));
    }
    return commit(() => ({ action: 'MUTATE_DOMAIN_RULES', operations, expectedRevision: revision }));
  }

  function assign(domains, proxyId) {
    if (!proxyId || !domains.length) return Promise.resolve(false);
    return commit(() => ({ action: 'ASSIGN_DOMAIN_PROXIES', domains, proxyId, expectedRevision: dataRevision }));
  }

  let renderedCount = 0;
  let currentFilteredItems = [];
  let filteredSelectionCount = 0;
  let cardIndex = createDomainCardIndex(state);
  let searchTimer = null;
  let proxySelectTemplate = null;
  const CHUNK_SIZE = 100;
  const SEARCH_DELAY_MS = 175;

  function cancelSearch() {
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  function render() {
    if (el.includedCount) el.includedCount.textContent = cardIndex.count('included');
    if (el.excludedCount) el.excludedCount.textContent = cardIndex.count('excluded');
    if (el.whitelistCount) el.whitelistCount.textContent = cardIndex.count('whitelist');
    if (el.pacCount) el.pacCount.textContent = cardIndex.count('pac');

    el.tabBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.subtab === state.activeSubTab);
      btn.setAttribute('aria-pressed', String(btn.dataset.subtab === state.activeSubTab));
    });

    const positive = state.activeSubTab === 'included';
    el.newRuleProxyRow.hidden = state.activeSubTab === 'pac' || (!state.rawMode && !positive);
    el.proxyFilter.hidden = !positive;
    el.selectionToolbar.hidden = !positive;
    if (el.bulkDelete) el.bulkDelete.hidden = !scoped;
    renderDomainCards();
    renderBusy();
  }

  function renderDomainCards() {
    cancelSearch();
    if (!el.domainListContainer) return;
    const items = cardIndex.filter(state.activeSubTab, {
      query: (el.searchDomainInput?.value || '').toLowerCase().trim(),
      source: scoped ? '' : el.sourceFilter.value,
      proxy: !scoped && state.activeSubTab === 'included' ? el.proxyFilter.value : '',
      ruleMeta: state.ruleMeta,
      domainProxyIds: state.domainProxyIds,
    });
    currentFilteredItems = items;
    filteredSelectionCount = 0;
    if (selectedDomains.size) for (const domain of items) if (selectedDomains.has(domain)) filteredSelectionCount++;
    updateSelection();
    renderedCount = 0;
    el.domainListContainer.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const title = document.createElement('p');
      title.style.cssText = 'font-size:16px;margin-bottom:6px';
      title.textContent = t("msg_the_list_is_empty_b6009443", "Список пуст");
      const hint = document.createElement('p');
      hint.style.fontSize = '13px';
      hint.textContent = t("msg_enter_a_domain_above_or_import_a_txt_file_0365a156", "Введите домен выше или загрузите файл (.txt)");
      empty.append(title, hint);
      el.domainListContainer.append(empty);
      return;
    }

    appendNextDomainChunk();
  }

  function appendNextDomainChunk() {
    if (!el.domainListContainer || renderedCount >= currentFilteredItems.length) return;

    const nextBatch = currentFilteredItems.slice(renderedCount, renderedCount + CHUNK_SIZE);
    const fragment = document.createDocumentFragment();

    nextBatch.forEach((domain) => {
      const card = document.createElement('div');
      card.className = 'domain-card';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'domain-name';
      nameSpan.title = domain;
      nameSpan.textContent = domain;

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-domain-btn';
      delBtn.title = t("msg_delete_be99b136", "Удалить");
      delBtn.dataset.domain = domain;
      delBtn.textContent = '✕';

      if (state.activeSubTab === 'included') {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'domain-select';
        checkbox.dataset.domain = domain;
        checkbox.checked = selectedDomains.has(domain);
        checkbox.setAttribute('aria-label', t('mpSelectDomain', 'Выбрать $1', [domain]));
        card.appendChild(checkbox);
      }
      card.appendChild(nameSpan);
      if (!scoped && state.activeSubTab === 'included') {
        if (!proxySelectTemplate) {
          proxySelectTemplate = document.createElement('select');
          proxySelectTemplate.className = 'domain-proxy-select';
          fillTargets(proxySelectTemplate, state.proxyCatalog, '', true);
          // Legacy is a display state, not a new assignment target.
          proxySelectTemplate.options[0].disabled = true;
        }
        const select = proxySelectTemplate.cloneNode(true);
        select.dataset.domain = domain;
        select.setAttribute('aria-label', t('mpDomainTarget', 'Прокси для $1', [domain]));
        const assigned = state.domainProxyIds[domain];
        if (assigned && !state.proxyCatalog.some(proxy => proxy.id === assigned)) {
          const missing = new Option(t('mpMissingProxy', 'Прокси недоступен'), assigned);
          missing.disabled = true;
          select.add(missing);
        }
        select.value = assigned || '';
        card.appendChild(select);
      }
      const meta = state.ruleMeta[`${state.activeSubTab === 'whitelist' ? 'whitelist' : 'exception'}:${domain}`];
      const source = document.createElement('small');
      source.className = 'rule-source';
      source.textContent = ruleSourceLabel(meta);
      source.title = meta?.site ? t("msg_resource_of_sub_85d3b7f7", "Ресурс сайта $1", [meta.site]) : t("msg_rule_source_a5e45b3c", "Источник правила");
      if (!scoped) card.appendChild(source);
      card.appendChild(delBtn);
      fragment.appendChild(card);
    });

    const scopedCheckboxes = scoped ? [...fragment.querySelectorAll('.domain-select')] : [];
    if (!loaded || loadFailed || pendingSaves) {
      for (const control of fragment.querySelectorAll('button, input, select')) control.disabled = true;
    }
    refreshSettingsHelp(fragment);
    el.domainListContainer.appendChild(fragment);
    if (scopedCheckboxes.length) {
      const description = t('settings_help_dl_select', 'Отметить домен для удаления из этого листа.');
      for (const checkbox of scopedCheckboxes) {
        checkbox.title = description;
        checkbox.setAttribute('aria-description', description);
        if (checkbox.closest('label')) checkbox.closest('label').title = description;
      }
    }
    renderedCount += nextBatch.length;
  }

  function updateSelection() {
    const count = filteredSelectionCount;
    el.selectAllFiltered.checked = Boolean(currentFilteredItems.length) && count === currentFilteredItems.length;
    el.selectAllFiltered.indeterminate = count > 0 && count < currentFilteredItems.length;
    el.selectionCount.textContent = t('mpSelectionCount', 'Выбрано: $1 · найдено: $2', [selectedDomains.size, currentFilteredItems.length]);
    el.bulkAssign.disabled = Boolean(pendingSaves) || !selectedDomains.size || !el.bulkProxy.value;
    if (el.bulkWildcardBtn) el.bulkWildcardBtn.disabled = !loaded || loadFailed || Boolean(pendingSaves) || !selectedDomains.size;
    if (el.bulkDelete) el.bulkDelete.disabled = !loaded || loadFailed || Boolean(pendingSaves) || !selectedDomains.size;
  }

  async function toggleSelectedWildcards() {
    if (!loaded || loadFailed || pendingSaves || !selectedDomains.size) return;
    const revision = dataRevision;
    const domains = [...selectedDomains];
    const parsed = domains.map((domain) => ({ raw: domain, norm: normalizeDomainRule(domain) }));
    const toggleable = parsed.filter(({ norm }) => {
      if (!norm.valid) return false;
      const bare = norm.domain.replace(/^\*\./, '');
      return norm.domain.startsWith('*.') || (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bare) && !bare.includes(':'));
    });
    if (!toggleable.length) return;
    const removePrefix = toggleable.every(({ norm }) => norm.domain.startsWith('*.'));
    const nextSelection = new Set();
    const renames = [];
    for (const domain of domains) {
      const toggled = toggleWildcardDomain(domain, removePrefix);
      const target = toggled.valid ? toggled.domain : domain;
      nextSelection.add(target);
      if (toggled.changed) renames.push({ from: domain, to: target });
    }
    if (!renames.length) return;

    if (scoped) {
      const renameMap = new Map(renames.map((r) => [r.from, r.to]));
      const nextList = [...new Set(listDomains.map((d) => renameMap.get(d) || d))];
      selectedDomains.clear();
      for (const d of nextSelection) selectedDomains.add(d);
      const ok = await commit(() => ({ action: 'SAVE_DOMAIN_LIST', listId, domains: nextList, expectedRevision: revision }));
      if (!ok) {
        selectedDomains.clear();
        for (const d of domains) selectedDomains.add(d);
        syncVisibleSelection();
      }
      return;
    }

    const addedTargets = new Set(renames.map((r) => r.to));
    const enabledIds = new Set(state.proxyCatalog.filter((p) => p.enabled).map((p) => p.id));
    const fallbackProxy = (el.newRuleProxy.value && enabledIds.has(el.newRuleProxy.value) ? el.newRuleProxy.value : '')
      || (state.defaultProxyId && enabledIds.has(state.defaultProxyId) ? state.defaultProxyId : '')
      || state.proxyCatalog.find((p) => p.enabled)?.id || '';
    const operations = [];
    for (const { from, to } of renames) {
      const existingProxy = state.exceptions[to] === true ? state.domainProxyIds[to] : undefined;
      const assigned = existingProxy || state.domainProxyIds[from];
      const proxyId = (assigned && enabledIds.has(assigned)) ? assigned : fallbackProxy;
      const addOp = { domain: to, mode: 'proxy' };
      if (proxyId) addOp.proxyId = proxyId;
      operations.push(addOp);
      if (!addedTargets.has(from)) {
        operations.push({ domain: from, mode: 'pac' });
      }
    }
    selectedDomains.clear();
    for (const d of nextSelection) selectedDomains.add(d);
    const ok = await mutate(operations, revision);
    if (!ok) {
      selectedDomains.clear();
      for (const d of domains) selectedDomains.add(d);
      syncVisibleSelection();
    }
  }

  function toggleRawSelectionWildcard() {
    if (!loaded || !el.rawTextEditor || el.rawTextEditor.disabled) return;
    const editor = el.rawTextEditor;
    const result = toggleWildcardLines(editor.value, editor.selectionStart, editor.selectionEnd);
    if (!result.changed) return;
    const scrollTop = editor.scrollTop;
    const scrollLeft = editor.scrollLeft;
    editor.value = result.text;
    editor.focus();
    editor.setSelectionRange(result.selectionStart, result.selectionEnd);
    editor.scrollTop = scrollTop;
    editor.scrollLeft = scrollLeft;
    scheduleRawTextAutosave();
  }

  function syncVisibleSelection() {
    for (const checkbox of el.domainListContainer.querySelectorAll('.domain-select')) {
      checkbox.checked = selectedDomains.has(checkbox.dataset.domain);
    }
    updateSelection();
  }

  function clearSelection() {
    selectedDomains.clear();
    filteredSelectionCount = 0;
    syncVisibleSelection();
  }

  async function addDomain(rawDomain) {
    if (!loaded || pendingSaves) return;
    const normalized = normalizeDomainRule(rawDomain);
    if (!normalized.valid) { showToast(normalized.error); return; }
    const tab = state.activeSubTab;
    const operation = { domain: normalized.domain, mode: tab === 'included' ? 'proxy' : tab === 'excluded' ? 'direct' : tab === 'pac' ? 'pac-bypass' : 'whitelist-add' };
    if (tab === 'included' && el.newRuleProxy.value) operation.proxyId = el.newRuleProxy.value;
    if (await mutate([operation]) && el.newDomainInput.value === rawDomain) el.newDomainInput.value = '';
  }

  function removeDomain(domain) {
    if (!loaded || pendingSaves) return;
    return mutate([{ domain, mode: state.activeSubTab === 'whitelist' ? 'whitelist-remove' : 'pac' }]);
  }

  async function handleClearList() {
    const revision = dataRevision, generation = resetGeneration;
    if (!loaded || pendingSaves) return;
    const whitelist = state.activeSubTab === 'whitelist';
    const domains = whitelist ? state.whitelist : state.activeSubTab === 'pac' ? state.pacBypassDomains : Object.keys(state.exceptions).filter(domain => state.exceptions[domain] === (state.activeSubTab === 'included'));
    if (!domains.length) return;
    if (!await confirmListAction(element,t('mpClearRules', 'Удалить правила текущего списка ($1)?', [domains.length]))) return;
    if (generation !== resetGeneration) return;
    await mutate(domains.map(domain => ({ domain, mode: whitelist ? 'whitelist-remove' : 'pac' })),revision);
  }

  async function handleFileImport(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (scoped) {
      const gen = resetGeneration, revision = dataRevision;
      try {
        const parsed = await readListFile(file);
        if (gen !== resetGeneration) return;
        if (!await confirmListAction(element,t('dlReplace','Заменить домены этого листа?'),listPreviewText(parsed))) return;
        if (gen !== resetGeneration) return;
        await commit(() => ({action:'SAVE_DOMAIN_LIST',listId,domains:parsed.validDomains,expectedRevision:revision}));
      } catch(cause) { if (gen === resetGeneration) showToast(cause.message); }
      finally { e.target.value = ''; }
      return;
    }
    const target = state.activeSubTab;
    const importGeneration = resetGeneration;
    const importBaseRevision = dataRevision;
    const proxyId = target === 'included' ? el.newRuleProxy.value || undefined : undefined;

    try {
      const { validDomains, skippedCount } = await readManualDomainFile(file);
      if (importGeneration !== resetGeneration) return;
      if (target === 'pac') {
        await mutate(validDomains.map(domain=>({domain,mode:'pac-bypass'})),importBaseRevision);
        return;
      }
      const saved = await commit(() => ({ action: 'IMPORT_EXCEPTIONS_BATCH', domains: validDomains,
        target, proxyId, expectedRevision: importBaseRevision, reassignExisting: false }));
      if (!saved) return;
      showToast(t('mpImportCounts', 'Добавлено: $1 · изменено: $2 · без изменений: $3 · пропущено строк: $4',
        [saved.data.added, saved.data.changed, saved.data.unchanged, skippedCount]), 4500);
    } catch (err) {
      if (importGeneration === resetGeneration) showToast(t("msg_import_failed_sub_24315934", "❌ Ошибка загрузки: $1", [err.message]), 5500);
    } finally {
      // Reset file input so user can re-upload the same file if needed
      if (el.fileImportInput) el.fileImportInput.value = '';
    }
  }

  // Handle File Export
  async function handleFileExport() {
    let domains = [];
    let fileName = 'domains.txt';

    if (scoped) {
      const generation = resetGeneration;
      try {
        // Read name and contents from one saved snapshot; another options tab
        // may have renamed the list before our deferred refresh runs.
        const response = await sendMessage(readRequest());
        if (generation !== resetGeneration) return;
        if (!validResponse(response) || typeof response.data.list.name !== 'string') throw new Error('List unavailable');
        domains = [...response.data.list.domains].sort();
        fileName = domainListExportFilename(response.data.list.name);
      } catch {
        if (generation === resetGeneration) showToast(t('msg_failed_to_load_data_de4395f1', 'Ошибка загрузки данных'));
        return;
      }
    } else if (state.activeSubTab === 'included') {
      domains = Object.keys(state.exceptions).filter((k) => state.exceptions[k] === true).sort();
      fileName = 'proxied-domains.txt';
    } else if (state.activeSubTab === 'excluded') {
      domains = Object.keys(state.exceptions).filter((k) => state.exceptions[k] === false).sort();
      fileName = 'direct-exceptions.txt';
    } else if (state.activeSubTab === 'whitelist') {
      domains = [...state.whitelist].sort();
      fileName = 'whitelist-domains.txt';
    } else if (state.activeSubTab === 'pac') {
      domains = [...state.pacBypassDomains].sort();
      fileName = 'pac-domains.txt';
    }

    if (domains.length === 0) {
      showToast(t("msg_the_current_list_is_empty_nothing_to_export_158a939a", "Текущий список пуст — нечего экспортировать"));
      return;
    }

    const header = t("msg_domain_list_sub_exported_sub_count_sub_9dfe7642", "# Список доменов ($1)\n# Экспортировано: $2\n# Количество: $3\n\n", [state.activeSubTab, new Date().toLocaleString(uiLocale()), domains.length]);
    const blob = new Blob([(scoped ? '' : header) + domains.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t("msg_exported_sub_domains_to_sub_5cb228f3", "✓ Экспортировано $1 доменов в файл $2!", [domains.length, fileName]));
  }

  let editorActionBusy = false;
  const runEditorAction = action => async () => {
    if (editorActionBusy) return;
    editorActionBusy = true;
    try { await action(resetGeneration); }
    finally { editorActionBusy = false; }
  };

  async function toggleMode(generation) {
    await saveQueue;
    if (generation !== resetGeneration) return;
    if (!state.rawMode) {
      state.rawMode = true;
      render();
      if (!scoped) root.querySelector('.editor-help-card').textContent = state.activeSubTab === 'pac'
        ? t('dlRawHelp','Один домен или wildcard на строку. URL преобразуются в домены; пути не учитываются.')
        : manualRawHelp;
      el.importFileBtn.disabled = true;
      el.exportFileBtn.disabled = true;
      el.listViewSection.style.display = 'none';
      el.editorViewSection.style.display = 'block';
      fillRawEditor();
      el.modeToggleBtn.textContent = t("msg_list_a3e77aea", "📋 Список");
      rawEditorDirty = false;
    } else {
      if (!await flush() || generation !== resetGeneration) return;
      state.rawMode = false;
      el.importFileBtn.disabled = false;
      el.exportFileBtn.disabled = false;
      el.editorViewSection.style.display = 'none';
      el.listViewSection.style.display = 'block';
      el.modeToggleBtn.textContent = t("msg_text_mode_e918f67f", "📝 Текстовый режим");
      render();
    }
  }

  function fillRawEditor() {
    if (scoped) el.rawTextEditor.value = listDomains.join('\n');
    else if (state.activeSubTab === 'pac') el.rawTextEditor.value = state.pacBypassDomains.join('\n');
    else {
      const incList = Object.keys(state.exceptions).filter(k => state.exceptions[k] === true);
      const excList = Object.keys(state.exceptions).filter(k => state.exceptions[k] === false);
      el.rawTextEditor.value = t("msg_proxy_sub_direct_sub_allowlist_sub_9f111eff", "# ПРОКСИРОВАТЬ:\n$1\n\n===============================\n# НЕ ПРОКСИРОВАТЬ:\n$2\n\n===============================\n# БЕЛЫЙ СПИСОК:\n$3\n", [incList.join('\n'), excList.join('\n'), state.whitelist.join('\n')]);
    }
    const parsed = validateRawText();
    if (parsed && !parsed.skippedCount) el.editorStatusText.textContent = t('msg_changes_are_saved_automatically_6ce33e8e', 'Изменения сохраняются автоматически');
  }

  async function saveRawText(editRevision = rawEditRevision) {
    if (rawAutosaveTimer !== null) {
      clearTimeout(rawAutosaveTimer);
      rawAutosaveTimer = null;
    }
    const text = el.rawTextEditor.value;
    const validation = validateRawText();
    if (!validation || validation.skippedCount) return false;
    if (scoped || state.activeSubTab === 'pac') {
      if (rawConflict) return false;
      const parsed = validation;
      const result = await commit(() => scoped ? {action:'SAVE_DOMAIN_LIST',listId,domains:parsed.validDomains,expectedRevision:dataRevision}
        : {action:'SAVE_MODS',mods:{pacBypassDomains:parsed.validDomains},expectedRevision:dataRevision},{raw:true});
      if (result && editRevision === rawEditRevision) { rawEditorDirty=false; el.editorStatusText.textContent=t('msg_saved_6c67d096','✓ Сохранено'); }
      return Boolean(result);
    }
    const sections = text
      .trim()
      .split(/^[^\S\r\n]*=+[^\S\r\n]*$/m)
      .map((s) => s.trim().split(/(?:\s*\r?\n\s*)+/g).filter(Boolean));

    const [incRaw = [], excRaw = [], whiteRaw = []] = sections;
    const incRes = parseDomainRuleLines(incRaw);
    const excRes = parseDomainRuleLines(excRaw);
    const whiteRes = parseDomainRuleLines(whiteRaw);

    const totalSkipped = incRes.skippedCount + excRes.skippedCount + whiteRes.skippedCount;

    const newExceptions = {};
    incRes.validDomains.forEach((host) => (newExceptions[host] = true));
    excRes.validDomains.forEach((host) => (newExceptions[host] = false));



    if (el.editorStatusText) el.editorStatusText.textContent = t("msg_saving_057ec605", "⏳ Сохранение…");
    if (rawConflict) return false;
    const wasSaved = await commit(() => ({ action: 'SAVE_MODS',
      mods: { exceptions: newExceptions, whitelist: whiteRes.validDomains },
      expectedRevision: dataRevision, proxyId: el.newRuleProxy.value || undefined }), { raw: true });
    if (!wasSaved) return false;

    const skipMsg = totalSkipped > 0 ? t("msg_invalid_lines_skipped_sub_512d33d2", " (пропущено некорректных строк: $1)", [totalSkipped]) : '';
    if (editRevision === rawEditRevision) {
      rawEditorDirty = false;
      if (el.editorStatusText) {
        el.editorStatusText.textContent = t("msg_saved_automatically_sub_8848e52e", "✓ Сохранено автоматически$1", [skipMsg]);
      }
    }
    return true;
  }

  function scheduleRawTextAutosave() {
    rawEditRevision += 1;
    rawEditorDirty = true;
    if (rawAutosaveTimer !== null) clearTimeout(rawAutosaveTimer);
    if (el.editorStatusText) {
      el.editorStatusText.textContent = t("msg_changes_will_be_saved_automatically_6db8e4d6", "Изменения будут сохранены автоматически…");
    }
    // Large lists are validated after typing settles (or synchronously on
    // flush), never once per keystroke. saveRawText validates before any write.
    if (el.rawTextEditor.value.length <= 65536) {
      const parsed = validateRawText();
      if (!parsed || parsed.skippedCount) { rawAutosaveTimer = null; return; }
    } else {
      rawInvalidLines.clear(); rawHighlights.replaceChildren();
      el.rawTextEditor.setAttribute('aria-busy', 'true');
      el.rawRetrySave.hidden = true;
    }
    const editRevision = rawEditRevision;
    rawAutosaveTimer = setTimeout(() => {
      rawAutosaveTimer = null;
      saveRawText(editRevision);
    }, RAW_AUTOSAVE_DELAY_MS);
  }

  async function flush() {
    // A user can keep typing while the previous save is acknowledged. Drain
    // those newer edits too before navigation or switching to the visual list.
    for (;;) {
      if (rawEditorDirty && !await saveRawText(rawEditRevision)) return false;
      await saveQueue;
      if (!rawEditorDirty) return true;
    }
  }

  function setupEvents() {
    el.retrySitesLoad.addEventListener('click', loadData);
    el.sourceFilter.addEventListener('change', renderDomainCards);
    el.proxyFilter.addEventListener('change', renderDomainCards);
    el.bulkProxy.addEventListener('change', updateSelection);
    el.clearSelection.addEventListener('click', clearSelection);
    el.bulkDelete?.addEventListener('click',async()=>{
      const revision=dataRevision, generation=resetGeneration;
      const domains=[...selectedDomains];
      if (!domains.length || !await confirmListAction(element,t('mpClearRules','Удалить правила текущего списка ($1)?',[domains.length]))) return;
      if (generation !== resetGeneration) return;
      if(await mutate(domains.map(domain=>({domain,mode:'pac'})),revision)) clearSelection();
    });
    el.selectAllFiltered.addEventListener('change', () => {
      const checked = el.selectAllFiltered.checked;
      if (searchTimer !== null) renderDomainCards();
      for (const domain of currentFilteredItems) {
        if (checked) selectedDomains.add(domain);
        else selectedDomains.delete(domain);
      }
      filteredSelectionCount = checked ? currentFilteredItems.length : 0;
      syncVisibleSelection();
    });
    el.bulkAssign.addEventListener('click', async () => {
      const domains = [...selectedDomains];
      if (await assign(domains, el.bulkProxy.value)) clearSelection();
    });
    el.bulkWildcardBtn?.addEventListener('click', toggleSelectedWildcards);
    if (el.rawWildcardBtn) {
      el.rawWildcardBtn.addEventListener('mousedown', (e) => e.preventDefault());
      el.rawWildcardBtn.addEventListener('click', toggleRawSelectionWildcard);
    }
    el.domainListContainer.addEventListener('change', async event => {
      const target = event.target;
      if (target.matches('.domain-select')) {
        const domain = target.dataset.domain;
        if (target.checked && !selectedDomains.has(domain)) { selectedDomains.add(domain); filteredSelectionCount++; }
        else if (!target.checked && selectedDomains.delete(domain)) filteredSelectionCount--;
        updateSelection();
      } else if (target.matches('.domain-proxy-select')) {
        const previous = state.domainProxyIds[target.dataset.domain] || '';
        if (!await assign([target.dataset.domain], target.value)) target.value = previous;
      }
    });
    el.rawRetrySave.addEventListener('click', runEditorAction(async generation => {
      if (pendingSaves) return;
      const validation = validateRawText();
      if (!validation || validation.skippedCount) return;
      const editRevision = rawEditRevision;
      const response = await sendMessage(readRequest());
      if (generation !== resetGeneration || editRevision !== rawEditRevision) return;
      if (!validResponse(response)) { showToast(t('msg_failed_to_load_data_de4395f1', 'Ошибка загрузки данных')); return; }
      updateCatalog(response.data);
      applySnapshot(snapshot(response.data));
      onApplicationState(response.settingsState);
      loadFailed = false;
      rawConflict = false;
      await saveRawText(rawEditRevision);
    }));
    root.querySelector('#openHistoryBtn').addEventListener('click', () => navigate('history'));
    el.tabBtns.forEach((btn) => {
      btn.addEventListener('click', runEditorAction(async generation => {
        if (state.rawMode && !await flush()) return;
        if (generation !== resetGeneration) return;
        state.activeSubTab = btn.dataset.subtab;
        selectedDomains.clear();
        render();
        if (state.rawMode) {
          fillRawEditor();
          root.querySelector('.editor-help-card').textContent = state.activeSubTab === 'pac'
            ? t('dlRawHelp','Один домен или wildcard на строку. URL преобразуются в домены; пути не учитываются.') : manualRawHelp;
        }
      }));
    });

    if (el.addDomainBtn && el.newDomainInput) {
      el.addDomainBtn.addEventListener('click', () => addDomain(el.newDomainInput.value));
      el.newDomainInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addDomain(el.newDomainInput.value);
      });
    }

    if (el.searchDomainInput) {
      el.searchDomainInput.addEventListener('input', () => {
        cancelSearch();
        searchTimer = setTimeout(renderDomainCards, SEARCH_DELAY_MS);
      });
    }

    if (el.clearListBtn) {
      el.clearListBtn.addEventListener('click', handleClearList);
    }

    // Scroll listener for virtual / infinite chunk loading
    if (el.domainListContainer) {
      el.domainListContainer.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = el.domainListContainer;
        if (scrollTop + clientHeight >= scrollHeight - 120) {
          appendNextDomainChunk();
        }
      });

      // Event delegation for domain card deletion (O(1) listener for 30k+ domains)
      el.domainListContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.delete-domain-btn');
        if (btn && btn.dataset.domain) {
          removeDomain(btn.dataset.domain);
        }
      });
    }

    if (el.importFileBtn && el.fileImportInput) {
      el.importFileBtn.addEventListener('click', () => el.fileImportInput.click());
      el.fileImportInput.addEventListener('change', handleFileImport);
    }

    if (el.exportFileBtn) {
      el.exportFileBtn.addEventListener('click', handleFileExport);
    }

    if (el.modeToggleBtn) {
      el.modeToggleBtn.addEventListener('click', runEditorAction(toggleMode));
    }

    if (el.rawTextEditor) {
      el.rawTextEditor.addEventListener('input', scheduleRawTextAutosave);
      el.rawTextEditor.addEventListener('scroll', syncRawScroll);
    }
  }


  setupEvents();
  if (scoped) {
    root.querySelector('.sub-nav-tabs').hidden = true;
    root.querySelector('#openHistoryBtn').hidden = true;
    root.querySelector('.editor-help-card').textContent = t('dlRawHelp','Один домен или wildcard на строку. URL преобразуются в домены; пути не учитываются.');
  }
  setControlsEnabled(false);
  return {
    refresh: loadData,
    activate: loadData,
    cancelRead: () => { ++loadRevision; cancelSearch(); },
    invalidate: () => {
      dataRevision = null; ++loadRevision; ++resetGeneration;
      cancelSearch();
      loadFailed = true; el.retrySitesLoad.hidden = false;
      if (rawAutosaveTimer !== null) { clearTimeout(rawAutosaveTimer); rawAutosaveTimer = null; }
      if (rawEditorDirty) { rawConflict = true; el.rawRetrySave.hidden = false; }
      renderBusy();
    },
    flush,
  };
}
