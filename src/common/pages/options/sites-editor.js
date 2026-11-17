'use strict';

import { t, uiLocale } from '../../core/i18n.js';
import { refreshSettingsHelp } from './settings-help.js';
import { normalizeDomainRule, parseDomainRuleLines } from '../../core/domain-rules.js';
import { sendMessage } from '../shared/client.js';
import { ruleSourceLabel } from '../shared/rule-source.js';
import { initDomainListsEditor, confirmListAction, readListFile, listPreviewText, parseListText } from './domain-lists-editor.js';

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
  };

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
      if (scoped) listDomains = [...(res.data.list?.domains || [])];
      el.retrySitesLoad.hidden = true;
      if (loadFailed) setSaveStatus('saved', t("msg_autosave_c04c99b6", "✓ Автосохранение"));
      loadFailed = false;
      const catalogChanged = updateCatalog(mods);
      onApplicationState(res.settingsState);
      if (mods.unchanged && loaded) { if (catalogChanged) render(); renderBusy(); return; }
      state.exceptions = Object.assign({}, mods.exceptions || {});
      state.whitelist = [...(mods.whitelist || [])];
      state.pacBypassDomains = [...(mods.pacBypassDomains || [])];
      state.ruleMeta = mods.ruleMeta || {};
      state.domainProxyIds = mods.domainProxyIds || {};
      dataRevision = Number.isSafeInteger(mods.revision) ? mods.revision : null;
      loaded = true;
      setControlsEnabled(true);
      el.importFileBtn.disabled = state.rawMode;
      el.exportFileBtn.disabled = state.rawMode;
      el.retrySitesLoad.hidden = true;
      onApplicationState(res.settingsState);
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

  function applySnapshot(source) {
    const data = snapshot(source);
    if (scoped) listDomains = [...(source.list?.domains || [])];
    updateCatalog(data);
    state.exceptions = { ...(data.exceptions || {}) };
    state.whitelist = [...(data.whitelist || [])];
    state.pacBypassDomains = [...(data.pacBypassDomains || [])];
    state.ruleMeta = data.ruleMeta || {};
    state.domainProxyIds = data.domainProxyIds || {};
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
        applySnapshot(updated.data);
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
    el.rawRetrySave.disabled = !loaded || Boolean(pendingSaves);
    el.importFileBtn.disabled = !loaded || loadFailed || Boolean(pendingSaves) || state.rawMode;
    el.exportFileBtn.disabled = !loaded || loadFailed || Boolean(pendingSaves) || state.rawMode;
    el.bulkAssign.disabled = Boolean(pendingSaves) || !selectedDomains.size || !el.bulkProxy.value;
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
  const CHUNK_SIZE = 100;

  function render() {
    let incCount = 0;
    let excCount = 0;
    for (const k in state.exceptions) {
      if (Object.prototype.hasOwnProperty.call(state.exceptions, k)) {
        if (state.exceptions[k] === true) incCount++;
        else if (state.exceptions[k] === false) excCount++;
      }
    }
    const whiteCount = (state.whitelist && state.whitelist.length) || 0;

    if (el.includedCount) el.includedCount.textContent = incCount;
    if (el.excludedCount) el.excludedCount.textContent = excCount;
    if (el.whitelistCount) el.whitelistCount.textContent = whiteCount;
    if (el.pacCount) el.pacCount.textContent = state.pacBypassDomains.length;

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
    if (!el.domainListContainer) return;
    const filter = (el.searchDomainInput?.value || '').toLowerCase().trim();

    let items = [];
    if (state.activeSubTab === 'included') {
      for (const k in state.exceptions) {
        if (state.exceptions[k] === true) items.push(k);
      }
    } else if (state.activeSubTab === 'excluded') {
      for (const k in state.exceptions) {
        if (state.exceptions[k] === false) items.push(k);
      }
    } else if (state.activeSubTab === 'whitelist') {
      items = [...state.whitelist];
    } else if (state.activeSubTab === 'pac') {
      items = [...state.pacBypassDomains];
    }

    if (filter) {
      items = items.filter((d) => d.toLowerCase().includes(filter));
    }
    const source = scoped ? '' : el.sourceFilter.value;
    if (source) items = items.filter(domain => state.ruleMeta[`${state.activeSubTab === 'whitelist' ? 'whitelist' : 'exception'}:${domain}`]?.source === source);

    if (!scoped && state.activeSubTab === 'included' && el.proxyFilter.value) {
      items = items.filter(domain => el.proxyFilter.value === 'legacy'
        ? !state.domainProxyIds[domain] : state.domainProxyIds[domain] === el.proxyFilter.value);
    }
    items.sort();
    currentFilteredItems = items;
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
        const select = document.createElement('select');
        select.className = 'domain-proxy-select';
        select.dataset.domain = domain;
        select.setAttribute('aria-label', t('mpDomainTarget', 'Прокси для $1', [domain]));
        fillTargets(select, state.proxyCatalog, state.domainProxyIds[domain] || '', true);
        const assigned = state.domainProxyIds[domain];
        if (assigned && !state.proxyCatalog.some(proxy => proxy.id === assigned)) {
          const missing = new Option(t('mpMissingProxy', 'Прокси недоступен'), assigned);
          missing.disabled = true;
          select.add(missing);
          select.value = assigned;
        }
        // Legacy is a display state, not a new assignment target.
        select.options[0].disabled = true;
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

    refreshSettingsHelp(fragment);
    el.domainListContainer.appendChild(fragment);
    renderedCount += nextBatch.length;
  }

  function updateSelection() {
    const count = currentFilteredItems.filter(domain => selectedDomains.has(domain)).length;
    el.selectAllFiltered.checked = Boolean(currentFilteredItems.length) && count === currentFilteredItems.length;
    el.selectAllFiltered.indeterminate = count > 0 && count < currentFilteredItems.length;
    el.selectionCount.textContent = t('mpSelectionCount', 'Выбрано: $1 · найдено: $2', [selectedDomains.size, currentFilteredItems.length]);
    el.bulkAssign.disabled = Boolean(pendingSaves) || !selectedDomains.size || !el.bulkProxy.value;
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

  function parseAndValidateDomainLines(lines) {
    return parseDomainRuleLines(lines);
  }

  /**
   * Safely parse and validate domains from an uploaded File object.
   */
  async function parseAndValidateDomainFile(file) {
    if (!file) {
      throw new Error(t("msg_no_file_selected_69848927", "Файл не выбран"));
    }

    // 1. Check file extension against known incompatible/dangerous binary extensions
    const fileName = (file.name || '').toLowerCase();
    const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
    const dangerousExts = [
      'exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'iso', 'pdf',
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mp3', 'avi', 'mkv',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'apk', 'dmg', 'class',
      'jar', 'dat', 'db', 'sqlite'
    ];

    if (ext && dangerousExts.includes(ext)) {
      throw new Error(t("msg_unsupported_file_format_sub_only_text_files_t_cf5e1a57", "Файл имеет неподдерживаемый формат (.$1). Поддерживаются только текстовые файлы (.txt) со списком доменов.", [ext]));
    }

    // 2. File size limit (5MB max ~ 100,000 domains)
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      throw new Error(t("msg_the_file_is_too_large_sub_mb_the_maximum_text_91d224d0", "Файл слишком большой ($1 МБ). Максимальный размер текстового файла: 5 МБ.", [(file.size / (1024 * 1024)).toFixed(1)]));
    }

    // 3. Read file safely as text (UTF-8) with timeout
    let rawText = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      const timer = setTimeout(() => {
        reader.abort();
        reject(new Error(t("msg_reading_the_file_timed_out_17a620bb", "Превышено время чтения файла")));
      }, 15000);

      reader.onload = () => {
        clearTimeout(timer);
        resolve(reader.result);
      };
      reader.onerror = () => {
        clearTimeout(timer);
        reject(new Error(t("msg_failed_to_read_the_file_9985b0ad", "Не удалось прочитать файл")));
      };
      reader.onabort = () => {
        clearTimeout(timer);
        reject(new Error(t("msg_file_reading_was_cancelled_0f5f331d", "Чтение файла прервано")));
      };

      reader.readAsText(file, 'UTF-8');
    });

    if (typeof rawText !== 'string') {
      throw new Error(t("msg_failed_to_decode_the_file_contents_4db11ffb", "Не удалось декодировать содержимое файла"));
    }

    // 4. Strip UTF-8 Byte Order Mark (BOM) if present
    if (rawText.charCodeAt(0) === 0xFEFF) {
      rawText = rawText.slice(1);
    }

    if (!rawText.trim()) {
      throw new Error(t("msg_the_file_is_empty_or_contains_only_whitespace_43e3a1ec", "Файл пуст или содержит только пробелы"));
    }

    // 5. Binary data protection (check first 8KB for null bytes and non-printable control chars)
    const sample = rawText.slice(0, 8192);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(sample)) {
      throw new Error(t("msg_the_file_contains_unreadable_binary_data_only_c1ccf183", "Файл содержит нечитаемые бинарные данные. Поддерживаются только текстовые файлы (.txt) в кодировке UTF-8."));
    }

    // 6. Tokenize line by line (support CRLF, LF, CR) and validate
    const allLines = rawText.split(/\r?\n|\r/);
    const lines = allLines.slice(0, 100000);
    const { validDomains, skippedCount } = parseAndValidateDomainLines(lines);

    if (validDomains.length === 0) {
      throw new Error(t("msg_no_valid_domain_names_were_found_in_the_file__2067fc4b", "В файле не найдено ни одного корректного доменного имени (пропущено некорректных строк: $1).", [skippedCount]));
    }

    return { validDomains, skippedCount };
  }

  // Handle File Import
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
      } catch(cause) { showToast(cause.message); }
      finally { e.target.value = ''; }
      return;
    }
    const target = state.activeSubTab;
    const importGeneration = resetGeneration;
    const importBaseRevision = dataRevision;
    const proxyId = target === 'included' ? el.newRuleProxy.value || undefined : undefined;

    try {
      const { validDomains, skippedCount } = await parseAndValidateDomainFile(file);
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
      showToast(t("msg_import_failed_sub_24315934", "❌ Ошибка загрузки: $1", [err.message]), 5500);
    } finally {
      // Reset file input so user can re-upload the same file if needed
      if (el.fileImportInput) el.fileImportInput.value = '';
    }
  }

  // Handle File Export
  function handleFileExport() {
    let domains = [];
    let fileName = 'domains.txt';

    if (state.activeSubTab === 'included') {
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

  async function toggleMode() {
    await saveQueue;
    if (!state.rawMode) {
      state.rawMode = true;
      render();
      fillRawEditor();
      if (!scoped) root.querySelector('.editor-help-card').textContent = state.activeSubTab === 'pac'
        ? t('dlRawHelp','Один домен или wildcard на строку. URL преобразуются в домены; пути не учитываются.')
        : manualRawHelp;
      el.importFileBtn.disabled = true;
      el.exportFileBtn.disabled = true;
      el.listViewSection.style.display = 'none';
      el.editorViewSection.style.display = 'block';
      el.modeToggleBtn.textContent = t("msg_list_a3e77aea", "📋 Список");
      rawEditorDirty = false;
      if (el.editorStatusText) {
        el.editorStatusText.textContent = t("msg_changes_are_saved_automatically_6ce33e8e", "Изменения сохраняются автоматически");
      }
    } else {
      if (!await flush()) return;
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
    if (scoped) { el.rawTextEditor.value = listDomains.join('\n'); return; }
    if (state.activeSubTab === 'pac') { el.rawTextEditor.value = state.pacBypassDomains.join('\n'); return; }
    const incList = Object.keys(state.exceptions).filter(k => state.exceptions[k] === true);
    const excList = Object.keys(state.exceptions).filter(k => state.exceptions[k] === false);
    el.rawTextEditor.value = t("msg_proxy_sub_direct_sub_allowlist_sub_9f111eff", "# ПРОКСИРОВАТЬ:\n$1\n\n===============================\n# НЕ ПРОКСИРОВАТЬ:\n$2\n\n===============================\n# БЕЛЫЙ СПИСОК:\n$3\n", [incList.join('\n'), excList.join('\n'), state.whitelist.join('\n')]);
  }

  async function saveRawText(editRevision = rawEditRevision) {
    if (rawAutosaveTimer !== null) {
      clearTimeout(rawAutosaveTimer);
      rawAutosaveTimer = null;
    }
    const text = el.rawTextEditor.value;
    if (scoped || state.activeSubTab === 'pac') {
      if (rawConflict) return false;
      let parsed;
      try { parsed = parseListText(text); }
      catch(cause) { el.editorStatusText.textContent=cause.message; return false; }
      if (parsed.skippedCount) {
        el.editorStatusText.textContent=listPreviewText(parsed); el.rawRetrySave.hidden=false;
        return false;
      }
      const result = await commit(() => scoped ? {action:'SAVE_DOMAIN_LIST',listId,domains:parsed.validDomains,expectedRevision:dataRevision}
        : {action:'SAVE_MODS',mods:{pacBypassDomains:parsed.validDomains},expectedRevision:dataRevision},{raw:true});
      if (result && editRevision === rawEditRevision) { rawEditorDirty=false; el.editorStatusText.textContent=t('msg_saved_6c67d096','✓ Сохранено'); }
      return Boolean(result);
    }
    const sections = text
      .trim()
      .split(/=+/g)
      .map((s) => s.trim().split(/(?:\s*\r?\n\s*)+/g).filter(Boolean));

    const [incRaw = [], excRaw = [], whiteRaw = []] = sections;
    const incRes = parseAndValidateDomainLines(incRaw);
    const excRes = parseAndValidateDomainLines(excRaw);
    const whiteRes = parseAndValidateDomainLines(whiteRaw);

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
    el.clearSelection.addEventListener('click', () => { selectedDomains.clear(); render(); });
    el.bulkDelete?.addEventListener('click',async()=>{
      const revision=dataRevision, generation=resetGeneration;
      const domains=[...selectedDomains];
      if (!domains.length || !await confirmListAction(element,t('mpClearRules','Удалить правила текущего списка ($1)?',[domains.length]))) return;
      if (generation !== resetGeneration) return;
      if(await mutate(domains.map(domain=>({domain,mode:'pac'})),revision)) { selectedDomains.clear(); render(); }
    });
    el.selectAllFiltered.addEventListener('change', () => {
      for (const domain of currentFilteredItems) {
        if (el.selectAllFiltered.checked) selectedDomains.add(domain);
        else selectedDomains.delete(domain);
      }
      render();
    });
    el.bulkAssign.addEventListener('click', async () => {
      const domains = [...selectedDomains];
      if (await assign(domains, el.bulkProxy.value)) {
        domains.forEach(domain => selectedDomains.delete(domain));
        render();
      }
    });
    el.domainListContainer.addEventListener('change', async event => {
      const target = event.target;
      if (target.matches('.domain-select')) {
        if (target.checked) selectedDomains.add(target.dataset.domain);
        else selectedDomains.delete(target.dataset.domain);
        updateSelection();
      } else if (target.matches('.domain-proxy-select')) {
        const previous = state.domainProxyIds[target.dataset.domain] || '';
        if (!await assign([target.dataset.domain], target.value)) target.value = previous;
      }
    });
    el.rawRetrySave.addEventListener('click', async () => {
      if (pendingSaves) return;
      const generation = resetGeneration;
      const response = await sendMessage(readRequest());
      if (generation !== resetGeneration) return;
      if (!validResponse(response)) { showToast(t('msg_failed_to_load_data_de4395f1', 'Ошибка загрузки данных')); return; }
      applySnapshot(response.data);
      onApplicationState(response.settingsState);
      loadFailed = false;
      rawConflict = false;
      await saveRawText(rawEditRevision);
    });
    root.querySelector('#openHistoryBtn').addEventListener('click', () => navigate('history'));
    el.tabBtns.forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (state.rawMode && !await flush()) return;
        state.activeSubTab = btn.dataset.subtab;
        selectedDomains.clear();
        render();
        if (state.rawMode) {
          fillRawEditor();
          root.querySelector('.editor-help-card').textContent = state.activeSubTab === 'pac'
            ? t('dlRawHelp','Один домен или wildcard на строку. URL преобразуются в домены; пути не учитываются.') : manualRawHelp;
        }
      });
    });

    if (el.addDomainBtn && el.newDomainInput) {
      el.addDomainBtn.addEventListener('click', () => addDomain(el.newDomainInput.value));
      el.newDomainInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addDomain(el.newDomainInput.value);
      });
    }

    if (el.searchDomainInput) {
      el.searchDomainInput.addEventListener('input', renderDomainCards);
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
      el.modeToggleBtn.addEventListener('click', toggleMode);
    }

    if (el.rawTextEditor) {
      el.rawTextEditor.addEventListener('input', scheduleRawTextAutosave);
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
    cancelRead: () => { ++loadRevision; },
    invalidate: () => {
      dataRevision = null; ++loadRevision; ++resetGeneration;
      loadFailed = true; el.retrySitesLoad.hidden = false;
      if (rawAutosaveTimer !== null) { clearTimeout(rawAutosaveTimer); rawAutosaveTimer = null; }
      if (rawEditorDirty) { rawConflict = true; el.rawRetrySave.hidden = false; }
      renderBusy();
    },
    flush,
  };
}
