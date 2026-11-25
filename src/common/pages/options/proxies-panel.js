import { t } from '../../core/i18n.js';
import { parseCustomProxies, parseProxyHostInput, proxyEndpointKey } from '../../core/utils.js';
import { MAX_PROXY_NAME_LENGTH, proxyNameLength } from '../../core/proxy-profiles.js';
import { refreshSettingsHelp } from './settings-help.js';
import { createProxyEditDraft, renderProxyConnectionEditor } from './proxy-connection-editor.js';
import { isProxyHealthFresh, renderProxyCardHealth } from './proxy-card-health.js';

export function initProxiesPanel(document, {
  appState, sendMessage, refreshState, invalidateStateRead, getResetGeneration, isResetBusy,
  showToast, showResponseError, isPrivateBrowsingPermissionError, setActionableErrorElement,
  onWarningAction, onSitesChanged, onMutationSettled,
}) {
  const el = {};
  el.homeProxyWarningBanner = document.getElementById('homeProxyWarningBanner');
  el.homeProxyWarningText = document.getElementById('homeProxyWarningText');
  // Own Proxies Form & Controls
  el.proxyFormView = document.getElementById('proxyFormView');
  el.proxyRawView = document.getElementById('proxyRawView');
  el.proxyEditorModeToggle = document.getElementById('proxyEditorModeToggle');
  el.proxyFormAlert = document.getElementById('proxyFormAlert');
  el.proxyFormAlertText = document.getElementById('proxyFormAlertText');
  el.proxyName = document.getElementById('proxyName');
  initProxyNameInput(el.proxyName);
  el.defaultProxySelect = document.getElementById('defaultProxySelect');
  el.proxyFailoverSelect = document.getElementById('proxyFailoverSelect');
  el.proxyProtocol = document.getElementById('proxyProtocol');
  el.proxyHost = document.getElementById('proxyHost');
  el.proxyPort = document.getElementById('proxyPort');
  el.authSectionWrapper = document.getElementById('authSectionWrapper');
  el.proxyAuthCheck = document.getElementById('proxyAuthCheck');
  el.proxyAuthFields = document.getElementById('proxyAuthFields');
  el.proxyUser = document.getElementById('proxyUser');
  el.proxyPass = document.getElementById('proxyPass');
  el.socksNotice = document.getElementById('socksNotice');
  el.addProxyBtn = document.getElementById('addProxyBtn');
  el.addProxyBtnIcon = document.getElementById('addProxyBtnIcon');
  el.addProxyBtnText = document.getElementById('addProxyBtnText');
  el.recheckAllProxiesBtn = document.getElementById('recheckAllProxiesBtn');
  el.proxyCardsList = document.getElementById('proxyCardsList');
  el.customProxyText = document.getElementById('customProxyText');
  el.saveProxiesBtn = document.getElementById('saveProxiesBtn');
  el.torToggle = document.getElementById('torToggle');
  el.warpToggle = document.getElementById('warpToggle');
  el.ownOnlyToggle = document.getElementById('ownOnlyToggle');

  let proxyAddBusy = false;
  let proxyProfileBusy = false;
  const proxyProfileDrafts = new Map();
  let proxyTextDirty = false;
  let proxyTextBase = '';

  function updateProxyDraftHint() {
    const hint = document.getElementById('proxyDraftHint');
    const conflict = proxyTextDirty && proxyTextBase !== (appState.pacMods.customProxyStringRaw || '');
    const text = conflict ? t("msg_the_saved_list_has_changed_your_draft_has_not_36e48c20", "Сохранённый список изменился. Ваш текст ещё не применён; «Применить» заменит список.") :
      proxyTextDirty ? t("msg_not_saved_apply_will_replace_the_entire_proxy_e8c154bc", "Не сохранено. «Применить» заменит весь список прокси.") : t("msg_use_apply_to_save_changes_to_this_list_278f74a1", "Изменения списка применяются кнопкой «Применить».");
    if (hint.textContent !== text) hint.textContent = text;
  }

  function hasAnyWorkingProxy() {
    const tor = Boolean(appState.pacMods?.ifUseLocalTor);
    const warp = Boolean(appState.pacMods?.ifUseLocalWarp);
    if (tor || warp) return true;

    const customList = parseCustomProxies(appState.pacMods?.customProxyStringRaw || '');
    if (!customList.length) return false;

    return customList.some((p) => {
      const st = appState.proxyHealthMap[p.raw];
      if (!st || st.checking) return true;
      if (!isProxyHealthFresh(st)) return true;
      return st.ok === true;
    });
  }

  // Check Health of a Single Proxy
  async function checkProxyAvailability(proxyRaw) {
    appState.proxyHealthMap[proxyRaw] = Object.assign(
      {},
      appState.proxyHealthMap[proxyRaw],
      { checking: true },
    );
    renderCustomProxiesList();
    updateHomeWarning();

    const res = await sendMessage({ action: 'CHECK_PROXY_HEALTH', proxy: proxyRaw });
    if (res.stale) return;
    if (res.success && res.data) {
      appState.proxyHealthMap[proxyRaw] = {
        checking: false,
        ok: res.data.ok,
        latency: res.data.latency,
        error: res.data.error,
        checkedAt: res.data.checkedAt,
      };
    } else {
      appState.proxyHealthMap[proxyRaw] = {
        checking: false,
        ok: false,
        error: res.error || t("msg_check_failed_4e395375", "Ошибка проверки"),
        checkedAt: Date.now(),
      };
    }

    renderCustomProxiesList();
    updateHomeWarning();
    return appState.proxyHealthMap[proxyRaw];
  }

  // Check Health of All Configured Proxies
  async function checkAllProxiesHealth() {
    const generation = getResetGeneration();
    const customList = parseCustomProxies(appState.pacMods.customProxyStringRaw);
    if (!customList.length) {
      updateHomeWarning();
      return;
    }

    for (const proxy of customList) {
      await checkProxyAvailability(proxy.raw);
      if (generation !== getResetGeneration()) return false;
    }
    return true;
  }

  // Update Home Page Warning Banner if proxies are dead
  function updateHomeWarning() {
    if (!el.homeProxyWarningBanner) return;

    setActionableErrorElement(el.homeProxyWarningBanner, false);
    const syncError = appState.syncState && appState.syncState.lastError;
    if (syncError) {
      const actionable = isPrivateBrowsingPermissionError(appState.syncState);
      setActionableErrorElement(el.homeProxyWarningBanner, actionable);
      el.homeProxyWarningBanner.style.display = 'flex';
      el.homeProxyWarningText.textContent = actionable
        ? t("msg_failed_to_apply_pac_sub_click_to_open_firefox_a5c7c194", "Не удалось применить PAC: $1 Нажмите, чтобы открыть разрешения Firefox.", [syncError])
        : t("msg_failed_to_apply_pac_sub_905498f4", "Не удалось применить PAC: $1", [syncError]);
      return;
    }

    const customList = parseCustomProxies(appState.pacMods.customProxyStringRaw);
    if (!customList.length) {
      el.homeProxyWarningBanner.style.display = 'none';
      return;
    }

    const deadProxies = customList.filter((p) => {
      const status = appState.proxyHealthMap[p.raw];
      return status && status.ok === false && !status.checking && isProxyHealthFresh(status);
    });

    if (deadProxies.length > 0) {
      el.homeProxyWarningBanner.style.display = 'flex';
      if (deadProxies.length === customList.length) {
        el.homeProxyWarningText.textContent = t("msg_warning_all_your_proxies_sub_are_unavailable_913b09a2", "Внимание: Все ваши прокси ($1) недоступны!", [deadProxies.length]);
      } else {
        el.homeProxyWarningText.textContent = t("msg_warning_sub_of_your_sub_proxies_are_unavailab_17a33ccc", "Внимание: $1 из $2 ваших прокси недоступен.", [deadProxies.length, customList.length]);
      }
    } else {
      el.homeProxyWarningBanner.style.display = 'none';
    }
  }

  // Update Protocol Controls Visibility
  function updateProtocolUI() {
    const proto = (el.proxyProtocol?.value || 'HTTP').toUpperCase();
    const isHttpFamily = proto === 'HTTP' || proto === 'HTTPS';

    if (isHttpFamily) {
      if (el.authSectionWrapper) el.authSectionWrapper.style.display = 'block';
      if (el.socksNotice) el.socksNotice.style.display = 'none';
      if (el.proxyPort && !el.proxyPort.value) {
        el.proxyPort.placeholder = proto === 'HTTP' ? '8080' : '443';
      }
    } else {
      // SOCKS5 or SOCKS4
      if (el.authSectionWrapper) el.authSectionWrapper.style.display = 'none';
      if (el.proxyAuthCheck) el.proxyAuthCheck.checked = false;
      if (el.proxyAuthFields) el.proxyAuthFields.style.display = 'none';
      if (el.socksNotice) el.socksNotice.style.display = 'flex';
      if (el.proxyPort && !el.proxyPort.value) {
        el.proxyPort.placeholder = '1080';
      }
    }
  }


  let editCards = new Map();
  let renderedRaw = null;
  let renderedStructure = null;
  let cardHealthViews = [];

  function addMissingProxy(select, id) {
    const option = new Option(t('mpMissingProxy', 'Прокси недоступен'), id);
    option.disabled = true;
    select.add(option);
  }

  function renderCustomProxiesList() {
    if (!el.proxyCardsList) return;

    const rawString = appState.pacMods.customProxyStringRaw || '';
    const catalog = appState.pacMods.proxyCatalog || appState.pacMods.proxyProfiles || [];
    const selectedDefault = appState.pacMods.defaultProxyId;
    const fallbackId = appState.pacMods.fallbackProxyId;
    const failover = fallbackId || (appState.pacMods.ownProxyOrDie === false ? 'direct' : 'block');
    const structure = JSON.stringify([catalog, selectedDefault, fallbackId, failover, proxyProfileBusy,
      [...proxyProfileDrafts].map(([id, draft]) => [id, draft.mode, draft.error])]);
    // Health-only refreshes must not detach a live form, focus, or a native menu.
    if (rawString === renderedRaw && structure === renderedStructure) {
      if (el.proxyFailoverSelect.value !== failover) el.proxyFailoverSelect.value = failover;
      for (const { raw, status, recheck } of cardHealthViews) renderProxyCardHealth(status, recheck, appState.proxyHealthMap[raw] || {});
      return;
    }

    const list = parseCustomProxies(rawString);
    cardHealthViews = [];
    el.defaultProxySelect.replaceChildren();
    const eligible = catalog.filter(proxy => proxy.enabled !== false);
    if (!eligible.length) el.defaultProxySelect.add(new Option(t('mpNoTargets', 'Нет доступных прокси'), ''));
    for (const profile of eligible) el.defaultProxySelect.add(new Option(profile.name, profile.id));
    if (selectedDefault && !eligible.some(proxy => proxy.id === selectedDefault)) addMissingProxy(el.defaultProxySelect, selectedDefault);
    el.defaultProxySelect.value = selectedDefault || '';
    el.defaultProxySelect.disabled = proxyProfileBusy || !eligible.length;

    el.proxyFailoverSelect.replaceChildren(
      new Option(t('proxyFailoverBlock', 'Блокировать соединение'), 'block'),
      new Option(t('proxyFailoverDirect', 'Напрямую · без защиты прокси'), 'direct'),
    );
    const reserves = document.createElement('optgroup');
    reserves.label = t('proxyFailoverReserve', 'Резервный прокси');
    for (const profile of catalog) {
      if (profile.enabled !== false || profile.id === fallbackId) {
        const option = new Option(`${profile.name}${profile.enabled === false ? ` · ${t('mpMissingProxy', 'Прокси недоступен')}` : ''}`, profile.id);
        option.disabled = profile.enabled === false;
        reserves.append(option);
      }
    }
    if (reserves.children.length) el.proxyFailoverSelect.append(reserves);
    if (fallbackId && !catalog.some(proxy => proxy.id === fallbackId)) addMissingProxy(el.proxyFailoverSelect, fallbackId);
    el.proxyFailoverSelect.value = failover;
    el.proxyFailoverSelect.disabled = proxyProfileBusy;

    const nextEditCards = new Map();

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = t("msg_no_custom_proxies_added_96a8dc56", "Свои прокси не добавлены");
      editCards = nextEditCards;
      el.proxyCardsList.replaceChildren(empty);
      renderedRaw = rawString;
      renderedStructure = structure;
      return;
    }

    const cards = list.map((item) => {
      const profile = catalog.find(proxy => !proxy.builtin && proxyEndpointKey(proxy.endpoint) === proxyEndpointKey(item));
      const health = appState.proxyHealthMap[item.raw] || {};

      const itemEl = document.createElement('div');
      itemEl.className = 'proxy-item';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'proxy-info';
      const identityDiv = document.createElement('div');
      identityDiv.className = 'proxy-identity';
      infoDiv.appendChild(identityDiv);

      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'proxy-badge';
      badgeSpan.textContent = item.type;
      identityDiv.appendChild(badgeSpan);
      if (profile) {
        const name = document.createElement('strong');
        name.className = 'proxy-profile-name';
        name.textContent = profile.name;
        name.title = profile.name;
        identityDiv.appendChild(name);
      }

      const addrSpan = document.createElement('span');
      addrSpan.className = 'proxy-addr';
      addrSpan.title = item.address;
      addrSpan.textContent = item.address;
      infoDiv.appendChild(addrSpan);

      if (item.hasAuth) {
        const authSpan = document.createElement('span');
        authSpan.className = 'proxy-auth-tag';
        authSpan.title = t("msg_authentication_59664d4b", "Авторизация");
        authSpan.textContent = '🔒';
        identityDiv.appendChild(authSpan);
      }

      const statusSpan = document.createElement('span');

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'proxy-actions';
      actionsDiv.hidden = profile && proxyProfileDrafts.get(profile.id)?.mode === 'edit';

      const recheckBtn = document.createElement('button');
      recheckBtn.className = 'icon-btn recheck-btn';
      recheckBtn.title = t("msg_check_availability_5579e6b7", "Проверить доступность");
      recheckBtn.setAttribute('aria-label', recheckBtn.title);
      renderProxyCardHealth(statusSpan, recheckBtn, health);
      cardHealthViews.push({ raw: item.raw, status: statusSpan, recheck: recheckBtn });
      const refreshIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      refreshIcon.setAttribute('viewBox', '0 0 24 24');
      refreshIcon.setAttribute('fill', 'none');
      refreshIcon.setAttribute('stroke', 'currentColor');
      refreshIcon.setAttribute('stroke-width', '1.75');
      refreshIcon.setAttribute('stroke-linecap', 'round');
      refreshIcon.setAttribute('stroke-linejoin', 'round');
      refreshIcon.setAttribute('aria-hidden', 'true');
      refreshIcon.setAttribute('focusable', 'false');
      const refreshPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      refreshPath.setAttribute('d', 'M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5');
      refreshIcon.appendChild(refreshPath);
      recheckBtn.appendChild(refreshIcon);
      recheckBtn.addEventListener('click', async () => {
        showToast(t("msg_checking_sub_39a95af3", "Проверка $1...", [item.address]));
        const res = await checkProxyAvailability(item.raw);
        if (!res) return;
        if (res.ok) {
          showToast(t("msg_sub_is_available_sub_ms_2be3b1ee", "✓ $1 доступен ($2 мс)", [item.address, res.latency]));
        } else {
          showToast(t("msg_sub_is_unavailable_sub_33e94220", "✕ $1 недоступен: $2", [item.address, res.error || t("msg_failed_4bdba3ac", "Сбой")]));
        }
      });
      actionsDiv.appendChild(recheckBtn);

      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn edit-proxy-btn';
      editBtn.title = t('proxyEditConnection', 'Редактировать подключение');
      editBtn.setAttribute('aria-label', editBtn.title);
      editBtn.disabled = !profile || proxyProfileBusy;
      const editIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      editIcon.setAttribute('viewBox', '0 0 24 24');
      editIcon.setAttribute('fill', 'none');
      editIcon.setAttribute('stroke', 'currentColor');
      editIcon.setAttribute('stroke-width', '1.75');
      editIcon.setAttribute('aria-hidden', 'true');
      const editPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      editPath.setAttribute('d', 'm16 3 5 5L9 20l-6 1 1-6ZM14 5l5 5');
      editIcon.append(editPath);
      editBtn.append(editIcon);
      editBtn.addEventListener('click', () => {
        try {
          proxyProfileDrafts.set(profile.id, createProxyEditDraft(profile, rawString));
        } catch (error) {
          showToast(error.message);
          return;
        }
        renderCustomProxiesList();
      });
      actionsDiv.append(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn delete delete-btn';
      deleteBtn.title = t("msg_delete_be99b136", "Удалить");
      deleteBtn.textContent = '✕';
      deleteBtn.disabled = !profile || proxyProfileBusy;
      deleteBtn.addEventListener('click', async () => {
        proxyProfileDrafts.set(profile.id, { mode: 'delete', replacementProxyId: '' });
        renderCustomProxiesList();
      });
      actionsDiv.appendChild(deleteBtn);

      const draft = profile && proxyProfileDrafts.get(profile.id);
      if (draft?.mode === 'edit') {
        const previous = editCards.get(profile.id);
        if (previous?.draft === draft && previous.busy === proxyProfileBusy &&
            previous.error === draft.error && previous.name === profile.name) {
          // Replace card chrome, not the live form (focus, caret and native menus).
          previous.card.children[0].replaceWith(infoDiv);
          previous.card.children[1].replaceWith(statusSpan);
          previous.card.children[2].replaceWith(actionsDiv);
          nextEditCards.set(profile.id, previous);
          return previous.card;
        }
        nextEditCards.set(profile.id, { card: itemEl, draft, busy: proxyProfileBusy, error: draft.error, name: profile.name });
      }
      itemEl.appendChild(infoDiv);
      itemEl.appendChild(statusSpan);
      itemEl.appendChild(actionsDiv);
      if (profile && proxyProfileDrafts.has(profile.id)) {
        itemEl.appendChild(renderProfileEditor(profile, eligible));
      }
      return itemEl;
    });
    editCards = nextEditCards;
    const next = new Set(cards);
    for (const card of [...el.proxyCardsList.children]) if (!next.has(card)) card.remove();
    const focusedCard = document.activeElement?.closest('.proxy-item');
    // Move neighbours instead of detaching the card that owns focus.
    const focusedIndex = cards.indexOf(focusedCard);
    if (focusedIndex >= 0) {
      for (const card of cards.slice(0, focusedIndex)) el.proxyCardsList.insertBefore(card, focusedCard);
      for (const card of cards.slice(focusedIndex + 1)) el.proxyCardsList.append(card);
    } else {
      for (const card of cards) el.proxyCardsList.append(card);
    }
    refreshSettingsHelp(el.proxyCardsList);
    renderedRaw = rawString;
    renderedStructure = structure;
  }

  async function mutateProxyProfile(message) {
    const generation = getResetGeneration();
    if (proxyProfileBusy) return false;
    proxyProfileBusy = true;
    invalidateStateRead();
    renderCustomProxiesList();
    try {
      const response = await sendMessage(message);
      if (response.stale) return false;
      if (!response?.success) {
        const error = response?.error?.message || response?.error || t('msg_failed_4bdba3ac', 'Сбой');
        const draft = proxyProfileDrafts.get(message.proxyId);
        if (draft) draft.error = error;
        showToast(error);
        return false;
      }
      // Do not replace metadata from a stale write acknowledgement.
      const refreshed = await refreshState();
      if (generation !== getResetGeneration()) return false;
      if (!refreshed) {
        showToast(t('mpReadbackFailed', 'Сохранено · обновите данные'));
        return false;
      }
      proxyProfileDrafts.delete(message.proxyId);
      onSitesChanged();
      return true;
    } catch (error) {
      showToast(error.message);
      return false;
    } finally {
      proxyProfileBusy = false;
      renderCustomProxiesList();
      onMutationSettled();
    }
  }

  function validateProxyNameInput(input) {
    input.setCustomValidity(proxyNameLength(input.value) > MAX_PROXY_NAME_LENGTH
      ? t('mpErrorName', 'Введите уникальное название из 1–32 символов. Имена Tor и Cloudflare WARP зарезервированы.') : '');
    return input.checkValidity();
  }

  function initProxyNameInput(input) {
    if (!input) return;
    // Native maxlength counts UTF-16 units; 32 astral code points need 64.
    // The shared normalized code-point check enforces the actual name limit.
    input.maxLength = MAX_PROXY_NAME_LENGTH * 2;
    input.addEventListener('input', () => validateProxyNameInput(input));
    validateProxyNameInput(input);
  }

  function renderProfileEditor(profile, eligible) {
    const draft = proxyProfileDrafts.get(profile.id);
    if (draft.mode === 'edit') return renderProxyConnectionEditor({
      profile, draft, busy: proxyProfileBusy,
      onSubmit: values => mutateProxyProfile({ action: 'UPDATE_PROXY_PROFILE', proxyId: profile.id, ...values }),
      onCancel: () => { proxyProfileDrafts.delete(profile.id); renderCustomProxiesList(); },
    });
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'proxy-profile-editor';
    fieldset.disabled = proxyProfileBusy;
    const legend = document.createElement('legend');
    legend.textContent = t('mpDeleteReplace', 'Удалить прокси · перенести сайты на');
    fieldset.append(legend);
    const input = document.createElement('select');
    input.setAttribute('aria-label', legend.textContent);
    input.add(new Option(t('mpChooseReplacement', 'Выберите замену явно'), ''));
    for (const proxy of eligible) if (proxy.id !== profile.id) input.add(new Option(proxy.name, proxy.id));
    input.value = draft.replacementProxyId;
    input.addEventListener('change', () => { draft.replacementProxyId = input.value; });
    const submit = document.createElement('button');
    submit.className = 'btn btn-secondary btn-sm';
    submit.textContent = t('msg_delete_be99b136', 'Удалить');
    submit.addEventListener('click', () => {
      // No guessed replacement; backend is authoritative about dependencies.
      if (eligible.some(proxy => proxy.id !== profile.id) && !input.value) { input.focus(); return; }
      mutateProxyProfile({ action: 'DELETE_PROXY_PROFILE', proxyId: profile.id, replacementProxyId: input.value || null });
    });
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary btn-sm';
    cancel.textContent = t('mpCancel', 'Отмена');
    cancel.addEventListener('click', () => { proxyProfileDrafts.delete(profile.id); renderCustomProxiesList(); });
    fieldset.append(input, submit, cancel);
    if (draft.error) {
      const error = document.createElement('small');
      error.className = 'profile-error';
      error.setAttribute('role', 'alert');
      error.textContent = draft.error;
      fieldset.append(error);
    }
    return fieldset;
  }

  // Add Proxy from Structured Form with Instant Health Check
  async function handleAddStructuredProxy() {
    const generation = getResetGeneration();
    if (proxyAddBusy) return;
    if (el.proxyFormAlert) el.proxyFormAlert.style.display = 'none';
    if (el.proxyName && !validateProxyNameInput(el.proxyName)) { el.proxyName.reportValidity(); return; }

    const protocol = (el.proxyProtocol?.value || 'HTTP').toUpperCase();
    let host = (el.proxyHost?.value || '').trim();
    let port = (el.proxyPort?.value || '').trim();
    const hasAuth = el.proxyAuthCheck?.checked && (protocol === 'HTTP' || protocol === 'HTTPS');
    const user = (el.proxyUser?.value || '').trim();
    const pass = (el.proxyPass?.value || '').trim();

    if (!host) {
      showFormAlert(t("msg_enter_an_ip_address_or_host_e_g_127_0_0_1_acccaf52", "Укажите IP-адрес или хост (напр. 127.0.0.1)"));
      el.proxyHost?.focus();
      return;
    }

    const parsedHostInput = parseProxyHostInput(host, port);
    if (!parsedHostInput) {
      showFormAlert(t("msg_invalid_ip_address_or_host_883d3e7e", "Некорректный IP-адрес или хост"));
      el.proxyHost?.focus();
      return;
    }
    host = parsedHostInput.host;
    port = parsedHostInput.port;

    if (!port) {
      port = protocol === 'HTTP' ? '8080' : protocol === 'HTTPS' ? '443' : '1080';
    }

    let proxyLine = '';
    if (hasAuth && (user || pass)) {
      proxyLine = `${protocol} ${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
      proxyLine = `${protocol} ${host}:${port}`;
    }

    const [candidateProxy] = parseCustomProxies(proxyLine);
    if (!candidateProxy) {
      showFormAlert(t("msg_check_the_proxy_address_and_port_1_65535_12481406", "Проверьте адрес прокси и номер порта (1–65535)"));
      return;
    }

    const currentRaw = appState.pacMods.customProxyStringRaw || '';
    const currentList = parseCustomProxies(currentRaw);

    // Check duplicates
    if (currentList.some((p) => p.address === candidateProxy.address && p.type === candidateProxy.type)) {
      showFormAlert(t("msg_this_proxy_is_already_in_the_list_84e5bfa6", "Такой прокси уже добавлен в список"));
      return;
    }

    const formFields = [el.proxyName, el.proxyHost, el.proxyPort, el.proxyUser, el.proxyPass];
    const submittedValues = formFields.map(input => input?.value);
    const submittedProtocol = el.proxyProtocol?.value;
    const submittedAuth = el.proxyAuthCheck?.checked;
    proxyAddBusy = true;
    invalidateStateRead();
    setAddButtonLoading(true);
    try {
      const res = await sendMessage({ action: 'ADD_PROXY', proxy: proxyLine, name: el.proxyName?.value.trim() || undefined });
      if (res.stale) return;
      if (!res.success) {
        const error = res.error || t("msg_failed_4bdba3ac", "Сбой");
        showFormAlert(res.data?.health?.ok === false
          ? t("msg_proxy_unavailable_sub_d325e3a8", "Прокси недоступен: $1", [error]) : error);
        if (isPrivateBrowsingPermissionError(res)) showResponseError(res);
        return;
      }
      const refreshed = await refreshState();
      if (generation !== getResetGeneration()) return;
      if (!refreshed) {
        showFormAlert(t('proxyAddedRefreshFailed', 'Прокси добавлен, но не удалось обновить его состояние. Обновите страницу настроек.'));
        return;
      }
      const health = res.data.health;
      const proxy = res.data.proxy;
      if (parseCustomProxies(appState.pacMods.customProxyStringRaw).some(item => item.raw === proxy) &&
          (appState.proxyHealthMap[proxy]?.checkedAt || 0) <= health.checkedAt) {
        appState.proxyHealthMap[proxy] = { ...health, checking: false };
      }
      if (formFields.every((input, index) => input?.value === submittedValues[index]) &&
          el.proxyProtocol?.value === submittedProtocol && el.proxyAuthCheck?.checked === submittedAuth) {
        formFields.forEach(input => { if (input) input.value = ''; });
      }
      renderCustomProxiesList();
      updateHomeWarning();
      showToast(t("msg_proxy_is_available_sub_ms_and_has_been_added_fab250e5", "✓ Прокси доступен ($1 мс) и добавлен!", [health.latency]));
    } catch (err) {
      showFormAlert(t('proxyAddFailed', 'Не удалось добавить прокси: $1', [err.message || t("msg_failed_4bdba3ac", "Сбой")]));
    } finally {
      proxyAddBusy = false;
      setAddButtonLoading(false);
      onMutationSettled();
    }
  }

  function showFormAlert(msg) {
    if (!el.proxyFormAlert || !el.proxyFormAlertText) return;
    el.proxyFormAlertText.textContent = msg;
    el.proxyFormAlert.style.display = 'flex';
  }

  function setAddButtonLoading(isLoading) {
    if (!el.addProxyBtn) return;
    el.addProxyBtn.disabled = isLoading;
    if (isLoading) {
      if (el.addProxyBtnIcon) el.addProxyBtnIcon.textContent = '⏳';
      if (el.addProxyBtnText) el.addProxyBtnText.textContent = t("msg_checking_f325c5cc", "Проверка...");
    } else {
      if (el.addProxyBtnIcon) el.addProxyBtnIcon.textContent = '+';
      if (el.addProxyBtnText) el.addProxyBtnText.textContent = t("msg_add_and_check_2392c0b8", "Добавить и проверить");
    }
  }


  function render() {
    const { pacMods } = appState;
      // Tor, WARP, Custom proxies
      if (el.torToggle) el.torToggle.checked = Boolean(pacMods.ifUseLocalTor);
      if (el.warpToggle) el.warpToggle.checked = Boolean(pacMods.ifUseLocalWarp);
      if (el.ownOnlyToggle) el.ownOnlyToggle.checked = Boolean(pacMods.ifUseOwnProxiesOnlyForOwnSites);
      document.getElementById('proxyAdvancedState').textContent = pacMods.ifUseOwnProxiesOnlyForOwnSites ? t("msg_a_restriction_is_enabled_6a5d64e3", "есть включённое ограничение") : '';
      if (el.customProxyText) {
        const saved = pacMods.customProxyStringRaw || '';
        if (!proxyTextDirty) {
          if (el.customProxyText.value !== saved) el.customProxyText.value = saved;
          proxyTextBase = saved;
        } else if (el.customProxyText.value === saved) {
          proxyTextDirty = false;
          proxyTextBase = saved;
        }
        updateProxyDraftHint();
      }
    renderCustomProxiesList();
    updateHomeWarning();
    updateProtocolUI();
  }

  function reset() {
    proxyProfileDrafts.clear();
    proxyTextDirty = false;
    proxyTextBase = '';
    el.customProxyText.value = '';
    [el.proxyName, el.proxyHost, el.proxyPort, el.proxyUser, el.proxyPass].forEach(input => { input.value = ''; });
    el.proxyName.setCustomValidity('');
    el.proxyProtocol.selectedIndex = 0;
    el.proxyAuthCheck.checked = false;
    el.proxyAuthFields.style.display = 'none';
    el.proxyFormAlert.style.display = 'none';
  }

  function bindEvents() {
    if (el.homeProxyWarningBanner) {
      const activateHomeWarning = (event) => {
        if (el.homeProxyWarningBanner.dataset.errorAction !==
            'open-private-browsing-settings') {
          return;
        }
        onWarningAction(event);
      };
      el.homeProxyWarningBanner.addEventListener('click', activateHomeWarning);
      el.homeProxyWarningBanner.addEventListener('keydown', activateHomeWarning);
    }

    el.defaultProxySelect.addEventListener('change', async () => {
      const proxyId = el.defaultProxySelect.value;
      if (!proxyId || proxyProfileBusy) return;
      await mutateProxyProfile({ action: 'SET_DEFAULT_PROXY', proxyId });
    });

    el.proxyFailoverSelect.addEventListener('change', async () => {
      const selected = el.proxyFailoverSelect.value;
      if (proxyProfileBusy || isResetBusy()) { renderCustomProxiesList(); return; }
      if (selected === 'direct' && !confirm(t('proxyFailoverDirectConfirm', 'При отказе прокси запросы пойдут напрямую: сайты увидят ваш IP-адрес. Разрешить?'))) {
        renderCustomProxiesList(); return;
      }
      await mutateProxyProfile({ action: 'SAVE_MODS', mods: {
        fallbackProxyId: ['block', 'direct'].includes(selected) ? null : selected,
        ownProxyOrDie: selected !== 'direct',
      } });
    });

    // Own Proxies: Protocol change updates UI
    if (el.proxyProtocol) {
      el.proxyProtocol.addEventListener('change', updateProtocolUI);
    }

    // Own Proxies: Auth Checkbox Toggle
    if (el.proxyAuthCheck && el.proxyAuthFields) {
      el.proxyAuthCheck.addEventListener('change', () => {
        el.proxyAuthFields.style.display = el.proxyAuthCheck.checked ? 'grid' : 'none';
      });
    }

    // Own Proxies: Add Structured Proxy Button
    if (el.addProxyBtn) {
      el.addProxyBtn.addEventListener('click', handleAddStructuredProxy);
    }

    // Own Proxies: Recheck All Proxies Button
    if (el.recheckAllProxiesBtn) {
      el.recheckAllProxiesBtn.addEventListener('click', async () => {
        if (el.recheckAllProxiesBtn.disabled) return;
        el.recheckAllProxiesBtn.disabled = true;
        try {
          showToast(t("msg_checking_all_proxies_eaa51f32", "Проверка всех прокси..."));
          if (await checkAllProxiesHealth() === false) return;
          showToast(t("msg_check_complete_880c43c5", "Проверка завершена"));
        } finally { el.recheckAllProxiesBtn.disabled = false; }
      });
    }

    // Own Proxies: Editor Mode Toggle (Form vs Raw Text)
    if (el.proxyEditorModeToggle) {
      el.proxyEditorModeToggle.addEventListener('click', () => {
        const isRaw = el.proxyRawView.style.display !== 'none';
        if (isRaw) {
          el.proxyRawView.style.display = 'none';
          el.proxyFormView.style.display = 'block';
          el.proxyEditorModeToggle.textContent = t("msg_text_3091aca2", "Текст");
        } else {
          el.proxyFormView.style.display = 'none';
          el.proxyRawView.style.display = 'block';
          el.proxyEditorModeToggle.textContent = t("msg_form_b26b88d6", "Форма");
          if (el.customProxyText && !proxyTextDirty) {
            el.customProxyText.value = appState.pacMods.customProxyStringRaw || '';
          }
        }
      });
    }

    // Save Raw Proxies Textarea
    el.customProxyText?.addEventListener('input', () => {
      if (!proxyTextDirty) proxyTextBase = appState.pacMods.customProxyStringRaw || '';
      proxyTextDirty = el.customProxyText.value !== (appState.pacMods.customProxyStringRaw || '');
      if (!proxyTextDirty) proxyTextBase = appState.pacMods.customProxyStringRaw || '';
      updateProxyDraftHint();
    });
    if (el.saveProxiesBtn) {
      el.saveProxiesBtn.addEventListener('click', async () => {
        if (el.saveProxiesBtn.disabled || isResetBusy()) return;
        const generation = getResetGeneration();
        const mods = {
          customProxyStringRaw: el.customProxyText?.value || '',
        };
        el.saveProxiesBtn.disabled = true;
        el.saveProxiesBtn.textContent = t("msg_saving_9c27c381", "Сохраняем…");
        try {
          const res = await sendMessage({ action: 'SAVE_MODS', mods });
          if (res.stale) return;
          if (res.success) {
            // A different view may have committed a newer list while apply was
            // pending. The acknowledgement is not the current shared snapshot.
            const refreshed = await refreshState();
            if (generation !== getResetGeneration()) return;
            if (!refreshed) {
              proxyTextDirty = true;
              proxyTextBase = mods.customProxyStringRaw;
              updateProxyDraftHint();
              showToast(t("msg_the_list_is_saved_refreshing_the_current_stat_ca109519", "Список сохранён. Обновление актуального состояния ещё не подтверждено."));
              return;
            }
            const saved = appState.pacMods.customProxyStringRaw || '';
            proxyTextDirty = el.customProxyText.value !== saved;
            proxyTextBase = proxyTextDirty ? mods.customProxyStringRaw : saved;
            updateProxyDraftHint();
            renderCustomProxiesList();
            if (saved !== mods.customProxyStringRaw) {
              showToast(t("msg_the_saved_list_has_already_changed_check_the__b38ea703", "Сохранённый список уже изменился. Проверьте актуальные данные и черновик."));
            } else {
              if (!appState.settingsState?.pending) checkAllProxiesHealth().catch(() => { });
              showToast(appState.settingsState?.pending ? t("msg_the_list_is_saved_applying_it_is_waiting_for__c9687d2a", "Список сохранён. Применение ожидает повторной попытки.") : t("msg_proxy_list_saved_375fb339", "Список прокси сохранён"));
            }
          } else {
            showResponseError(res, { fallback: t("msg_invalid_format_396ace06", "Неверный формат") });
          }
        } catch (error) {
          showToast(error.message || t("msg_failed_to_save_the_proxy_list_1196b92d", "Не удалось сохранить список прокси"));
        } finally {
          el.saveProxiesBtn.disabled = false;
          el.saveProxiesBtn.textContent = t("msg_apply_e15f960d", "Применить");
        }
      });
    }

    // Quick Toggles: Tor, WARP, OwnOnly
    const bindProxyToggle = (checkbox, key, localService = null) => {
      if (!checkbox) return;
      checkbox.addEventListener('change', async () => {
        if (checkbox.disabled || isResetBusy()) return;
        invalidateStateRead();
        const generation = getResetGeneration();
        // The current snapshot, not a stale pre-request value, is used on rollback.
        const enabled = Boolean(checkbox.checked);
        checkbox.disabled = true;

        try {
          if (localService && enabled) {
            showToast(t("msg_checking_local_proxy_cea92cfe", "Проверяем локальный прокси…"));
          }

          const res = localService
            ? await sendMessage({
              action: 'SET_LOCAL_PROXY_ENABLED',
              service: localService,
              enabled,
            })
            : await sendMessage({ action: 'SAVE_MODS', mods: { [key]: enabled } });

          if (res.stale || generation !== getResetGeneration()) return;
          if (!res.success) {
            checkbox.checked = Boolean(appState.pacMods?.[key]);
            const actionText = enabled ? t("msg_enable_54768313", "включить") : t("msg_disable_fa545d9d", "выключить");
            showResponseError(res, {
              prefix: t("msg_failed_to_sub_5342e22f", "Не удалось $1: ", [actionText]),
              fallback: t("msg_local_proxy_unavailable_9d04b608", "локальный прокси недоступен"),
              duration: 4500,
            });
            return;
          }

          appState.pacMods = localService ? res.data.pacMods : res.data;
          render();

          if (localService && enabled) {
            const health = res.data.health;
            const latency = Number.isFinite(health?.latency) ? t("msg_sub_ms_124b5754", ", $1 мс", [health.latency]) : '';
            showToast(t("msg_proxy_available_sub_sub_b4142c92", "✓ Прокси доступен: $1$2", [health.workingProxy, latency]));
          } else {
            showToast(t("msg_settings_updated_d8ea53b0", "Настройки обновлены"));
          }
        } catch (err) {
          if (generation !== getResetGeneration()) return;
          checkbox.checked = Boolean(appState.pacMods?.[key]);
          showToast(t("msg_error_sub_9ca75e4a", "Ошибка: $1", [err.message || t("msg_failed_to_save_the_setting_752f6fb0", "не удалось сохранить настройку")]), 4500);
        } finally {
          checkbox.checked = Boolean(appState.pacMods?.[key]);
          checkbox.disabled = false;
        }
      });
    };

    bindProxyToggle(el.torToggle, 'ifUseLocalTor', 'tor');
    bindProxyToggle(el.warpToggle, 'ifUseLocalWarp', 'warp');
    bindProxyToggle(el.ownOnlyToggle, 'ifUseOwnProxiesOnlyForOwnSites');
  }

  return {
    bindEvents, render, reset, hasAnyWorkingProxy,
    renderList: renderCustomProxiesList,
    isBusy: () => proxyAddBusy || proxyProfileBusy,
  };
}
