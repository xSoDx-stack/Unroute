import { t, uiLocale } from '../../core/i18n.js';
import { utils } from '../../core/utils.js';

export function initPacPanel(root, {
  getSyncState, setSyncState, sendMessage, showToast, showResponseError, hasAnyWorkingProxy, render,
}) {
  const el = {};
  el.syncDate = root.getElementById('syncDate');
  el.syncBtn = root.getElementById('syncBtn');
  el.syncBtnIcon = root.getElementById('syncBtnIcon');
  el.providerCards = root.querySelectorAll('.provider-card');
  el.customPacUrlBox = root.getElementById('customPacUrlBox');
  el.customPacUrlInput = root.getElementById('customPacUrlInput');
  el.saveCustomPacUrlBtn = root.getElementById('saveCustomPacUrlBtn');

  let requestRevision = 0;
  let manuallySyncing = false;

  function beginRequest({ saving = false, syncing = false } = {}) {
    const revision = ++requestRevision;
    manuallySyncing = syncing;
    if (el.saveCustomPacUrlBtn) el.saveCustomPacUrlBtn.disabled = saving;
    renderSyncIndicator();
    return () => revision === requestRevision;
  }

  function renderSyncIndicator() {
    const syncing = manuallySyncing || Boolean(getSyncState().isSyncing);
    el.syncBtnIcon?.classList.toggle('spinning', syncing);
    if (el.syncBtn) el.syncBtn.disabled = syncing;
  }

  function renderPanel() {
    const syncState = getSyncState();
    // Sync date & loading icon
    if (el.syncDate) {
      if (syncState.lastPacUpdateStamp) {
        const date = new Date(syncState.lastPacUpdateStamp);
        el.syncDate.textContent = date.toLocaleString(uiLocale(), {
          day: 'numeric',
          month: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } else {
        el.syncDate.textContent = t("msg_never_updated_e314a133", "Не обновлялся");
      }
    }

    renderSyncIndicator();

    // Selected Provider Radio Card & Individual Provider Update Dates
    const provStamps = syncState.providerUpdateStamps || {};
    const isCustomSelected = (syncState.currentPacProviderKey === 'customPacUrl');
    if (el.customPacUrlBox) {
      el.customPacUrlBox.style.display = isCustomSelected ? 'block' : 'none';
    }
    if (el.customPacUrlInput && syncState.customPacUrl && !el.customPacUrlInput.value) {
      el.customPacUrlInput.value = syncState.customPacUrl;
    }

    el.providerCards.forEach((card) => {
      const provKey = card.dataset.provider;
      const isSelected = provKey === (syncState.currentPacProviderKey || 'none');
      card.classList.toggle('selected', isSelected);
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = isSelected;

      const dateEl = card.querySelector('[data-provider-date]');
      if (dateEl) {
        if (provKey === 'onlyOwnSites') {
          dateEl.textContent = t("msg_local_rules_ff97b927", "Локальные правила");
        } else if (provKey === 'customPacUrl' && !syncState.customPacUrl) {
          dateEl.textContent = t("msg_enter_a_url_26d5dd4d", "Укажите ссылку");
        } else {
          const stamp = provStamps[provKey] || (provKey === syncState.currentPacProviderKey ? syncState.lastPacUpdateStamp : 0);
          if (stamp) {
            const d = new Date(stamp);
            dateEl.textContent = t("msg_updated_sub_0c40c480", "Обновлён: $1", [d.toLocaleString(uiLocale(), {
              day: 'numeric',
              month: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })]);
          } else {
            dateEl.textContent = t("msg_not_updated_yet_5b05f298", "Ещё не обновлялся");
          }
        }
      }
    });
  }

  function bindEvents() {
    // Custom PAC URL Apply Handler
    async function handleApplyCustomPacUrl() {
      const rawUrl = (el.customPacUrlInput?.value || '').trim();
      if (!rawUrl) {
        showToast(t("msg_enter_the_pac_script_url_be71f02a", "Введите адрес ссылки на PAC-скрипт"));
        el.customPacUrlInput?.focus();
        return;
      }

      const validation = utils.validatePacUrl(rawUrl);
      if (!validation.valid) {
        showToast(validation.error);
        el.customPacUrlInput?.focus();
        return;
      }

      const isCurrent = beginRequest({ saving: true });
      showToast(t("msg_downloading_and_applying_your_pac_script_73e85156", "Загрузка и применение своего PAC-скрипта..."));
      const res = await sendMessage({
        action: 'INSTALL_PAC',
        key: 'customPacUrl',
        customPacUrl: validation.sanitizedUrl,
      }, isCurrent);
      if (!isCurrent()) return;
      if (el.saveCustomPacUrlBtn) el.saveCustomPacUrlBtn.disabled = false;
      if (res.stale) return;

      if (res.success && res.data) {
        setSyncState(res.data);
        render();
        showToast(t("msg_your_pac_script_was_downloaded_and_applied_68bf08d2", "✓ Свой PAC-скрипт успешно загружен и применён!"));
      } else {
        showResponseError(res, { fallback: t("msg_failed_to_download_pac_34599d21", "Не удалось загрузить PAC") });
        render();
      }
    }

    if (el.saveCustomPacUrlBtn) {
      el.saveCustomPacUrlBtn.addEventListener('click', handleApplyCustomPacUrl);
    }
    if (el.customPacUrlInput) {
      el.customPacUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleApplyCustomPacUrl();
      });
    }

    // Provider Selection with Gating for onlyOwnSites and customPacUrl
    el.providerCards.forEach((card) => {
      const radio = card.querySelector('input[type="radio"]');
      radio?.addEventListener('change', async () => {
        if (!radio.checked) return;
        const key = card.dataset.provider;
        if (key === getSyncState().currentPacProviderKey) return;
        // Native change covers both label activation and arrow-key navigation.
        // Show the confirmed selection until the background responds.
        renderPanel();

        if (key === 'onlyOwnSites') {
          const canUseOwnSites = hasAnyWorkingProxy();
          if (!canUseOwnSites) {
            showToast(t("msg_no_working_proxy_configure_a_proxy_in_my_prox_5507b02d", "❌ Нет рабочего прокси! Настройте прокси во вкладке «Прокси»"), 3000);
            render();
            return;
          }
        }

        if (key === 'customPacUrl') {
          if (el.customPacUrlBox) el.customPacUrlBox.style.display = 'block';
          const urlToApply = (el.customPacUrlInput?.value || getSyncState().customPacUrl || '').trim();
          if (urlToApply) {
            const validation = utils.validatePacUrl(urlToApply);
            if (!validation.valid) {
              showToast(validation.error);
              el.customPacUrlInput?.focus();
              return;
            }
            const isCurrent = beginRequest();
            showToast(t("msg_installing_your_pac_script_6bee6c48", "Установка своего PAC-скрипта..."));
            const res = await sendMessage({ action: 'INSTALL_PAC', key: 'customPacUrl', customPacUrl: validation.sanitizedUrl }, isCurrent);
            if (!isCurrent() || res.stale) return;
            if (res.success) {
              setSyncState(res.data);
              render();
              showToast(t("msg_your_pac_script_is_installed_0e199b55", "Свой PAC-скрипт установлен!"));
            } else {
              showResponseError(res, { fallback: t("msg_failed_to_download_pac_34599d21", "Не удалось загрузить PAC") });
              render();
            }
          } else {
            el.customPacUrlInput?.focus();
            showToast(t("msg_enter_a_direct_pac_script_url_and_click_apply_bdc39d75", "Укажите прямую ссылку на PAC-скрипт и нажмите «Применить»"));
          }
          return;
        }

        const isCurrent = beginRequest();
        if (key === 'none') {
          showToast(t("msg_disabling_proxy_be6a5e5a", "Отключение прокси..."));
          const res = await sendMessage({ action: 'CLEAR_PAC' }, isCurrent);
          if (!isCurrent() || res.stale) return;
          if (res.success) {
            setSyncState(res.data);
            render();
            showToast(t("msg_proxy_disabled_a2fd1e2b", "Прокси отключён"));
          } else {
            showResponseError(res);
          }
          render();
        } else {
          showToast(t("msg_installing_pac_script_sub_eb597f4b", "Установка PAC-скрипта \"$1\"...", [getSyncState().providers[key]?.label || key]));
          const res = await sendMessage({ action: 'INSTALL_PAC', key }, isCurrent);
          if (!isCurrent() || res.stale) return;
          if (res.success) {
            setSyncState(res.data);
            render();
            showToast(t("msg_pac_script_sub_installed_35eaff15", "PAC-скрипт \"$1\" установлен!", [getSyncState().providers[key]?.label || key]));
          } else {
            showResponseError(res, { fallback: t("msg_failed_to_install_pac_3087f370", "Не удалось установить PAC") });
            render();
          }
        }
      });
    });

    // Manual Sync PAC
    if (el.syncBtn) {
      el.syncBtn.addEventListener('click', async () => {
        const currentKey = getSyncState().currentPacProviderKey;
        if (!currentKey || currentKey === 'none') {
          showToast(t("msg_select_a_pac_provider_first_2614fea6", "Сначала выберите PAC-провайдера"));
          return;
        }
        showToast(t("msg_updating_the_pac_script_07fb13cc", "Обновление PAC-скрипта..."));
        const isCurrent = beginRequest({ syncing: true });
        render();

        const res = await sendMessage({ action: 'SYNC_PAC', key: currentKey }, isCurrent);
        if (!isCurrent()) return;
        manuallySyncing = false;
        if (res.stale) { renderSyncIndicator(); return; }
        if (res.success) {
          setSyncState(res.data);
          showToast(t("msg_pac_script_updated_a7c851de", "PAC-скрипт успешно обновлён!"));
        } else {
          showResponseError(res, { prefix: t("msg_update_failed_798e384c", "Ошибка обновления: "), fallback: t("msg_network_failure_dd0f89b6", "Сбой сети") });
        }
        render();
      });
    }
  }

  function reset() {
    beginRequest();
    if (el.customPacUrlInput) el.customPacUrlInput.value = '';
  }

  return { render: renderPanel, bindEvents, reset };
}
