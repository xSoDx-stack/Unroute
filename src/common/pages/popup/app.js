'use strict';

import { t, localizeDocument } from '../../core/i18n.js';
import { initAppearance } from '../shared/appearance.js';

import { sendMessage, openSettings } from '../shared/client.js';
import { activeSite } from '../shared/site-context.js';
import { renderApplicationBanner } from '../shared/application-banner.js';
import { resourceProxySelect, siteRouteSelect, proxySelectControl, DIRECT_RESOURCE_ROUTE, RESET_RESOURCE_ROUTE, PAC_SITE_ROUTE, resourceDomainLabel } from './resource-proxies.js';


initAppearance();
localizeDocument();

const el = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
let site = null;

let busy = false;
let revision = 0;
let refreshTimer;
let storageRefreshPending = false;
let enabled = false;
let wholeSite = false;
let resourceRevision;
let resourceRulesEnabled = true;
let resourceReloadNeeded = false;
let inheritResources = true;
let canSetInheritance = false;
let resourceRoutes = {};
let applicationPending = false;
const sameSite = (left, right) => left?.tabId === right?.tabId && left?.fullHost === right?.fullHost && left?.incognito === right?.incognito;

function updateRouteHint() {
  const text = [el.actionScope.textContent, el.siteProxyWrap.querySelector('select')?.dataset.routeTitle, el.inheritResources.title, el.scope.textContent, el.source.textContent,
    el.notice.hidden ? el.notice.textContent : ''].filter(Boolean).join('\n\n');
  el.route.title = text;
  el.route.setAttribute('aria-description', text);
  const select = el.siteProxyWrap.querySelector('select');
  if (select) select.title = [select.dataset.routeTitle, el.actionScope.textContent, el.source.textContent,
    el.notice.hidden ? el.notice.textContent : ''].filter(Boolean).join('\n\n');
}
function notice(text, quiet = false) {
  el.notice.textContent = text || '';
  el.notice.hidden = !text || quiet;
  updateRouteHint();
}
function showLoadError(error) {
  el.loadError.hidden = false;
  el.loadErrorText.textContent = error.message || String(error);
  el.status.textContent = t("msg_no_connection_9f0c20cc", "Нет связи");
  el.status.className = 'status error';
  el.reload.disabled = true;
  setBusy(busy);
}
function setBusy(value) {
  busy = value;
  document.body.setAttribute('aria-busy', String(value));
  const blocked = value || !el.loadError.hidden;
  el.reload.disabled = blocked || applicationPending;
  el.resources.querySelectorAll('select').forEach(select => { select.disabled = blocked || !resourceRulesEnabled; });
  el.siteProxyWrap.querySelectorAll('select').forEach(select => { select.disabled = blocked; });
  el.inheritResources.disabled = blocked || !canSetInheritance;
  el.directResources.disabled = el.inheritResources.disabled;
  el.resourceMode.classList.toggle('disabled', el.inheritResources.disabled);
  if (!value && storageRefreshPending) scheduleStorageRefresh();
}

function scheduleStorageRefresh() {
  storageRefreshPending = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!busy && storageRefreshPending) refresh(true).catch(showLoadError);
  }, 100);
}

async function refresh(fromStorage = false) {
  storageRefreshPending = false;
  const requestRevision = ++revision;
  const current = await activeSite();
  const response = await sendMessage({ action: 'GET_STATE', currentDomain: current?.fullHost || '', currentTabId: current?.tabId });
  if (requestRevision !== revision) return;
  // The user may have opened a native menu while the state read was in flight.
  const active = document.activeElement;
  if (fromStorage && sameSite(site, current) && active?.matches('select') &&
      (el.siteProxyWrap.contains(active) || el.resources.contains(active))) {
    storageRefreshPending = true;
    return;
  }
  if (!response.success) { showLoadError(response.error || t("msg_failed_to_load_settings_76fbbdec", "Не удалось загрузить настройки.")); return; }
  el.loadError.hidden = true;
  if (!sameSite(site, current)) { resourceReloadNeeded = false; notice(''); }
  site = current;
  const data = response.data;
  resourceRoutes = data.siteResources?.routes || {};
  applicationPending = Boolean(data.settingsState?.pending);
  resourceRulesEnabled = data.pacMods.ifMindExceptions !== false;
  el.version.textContent = t("msg_version_sub_a48a5022", "Версия $1", [data.version]);
  el.version.closest('.brand').title = el.version.textContent;
  enabled = data.syncState.currentPacProviderKey !== 'none';
  const statusState = data.settingsState?.pending ? 'warning'
    : !enabled ? 'inactive'
      : data.syncState.isControlled ? 'active' : 'warning';
  el.status.textContent = data.settingsState?.pending ? t("msg_not_applied_09415f65", "Не применено") : enabled && data.syncState.isControlled ? t('fidelity_enabled', 'Включено') : enabled ? t("msg_no_control_cce05ad1", "Нет контроля") : t("msg_disabled_3e958000", "Отключено");
  el.status.className = `status ${statusState}`;
  renderApplicationBanner(el.applicationBanner, data.settingsState, () => refresh().catch(showLoadError));
  el.siteCard.hidden = !site;
  el.empty.hidden = Boolean(site);
  if (site) {
    el.domain.textContent = site.rootDomain;
    const match = data.pacMods.ifMindExceptions === false ? {} : data.currentSiteMatch || {};
    const siteProxyId = match.matched && match.isProxied ? match.proxyId || null : null;
    const siteSelect = siteRouteSelect(site.rootDomain,
      { mode: !match.matched ? 'pac' : match.isProxied ? 'proxy' : 'direct', proxyId: siteProxyId },
      data.pacMods.proxyCatalog || [], value => changeSiteMode(value === PAC_SITE_ROUTE ? 'pac' :
        value === DIRECT_RESOURCE_ROUTE ? 'direct' : 'proxy', value));
    siteSelect.dataset.routeTitle = [siteSelect.title,
      t('popupSiteProxyHelp', 'Выберите подключение сайта. Автоматические ресурсы используют отдельную настройку ниже; ручные исключения сохраняются.')].filter(Boolean).join('\n');
    el.siteProxyWrap.replaceChildren(siteSelect);
    el.siteProxyWrap.hidden = false;
    const resources = data.siteResources || {};
    resourceRevision = resources.rulesRevision ?? data.pacMods.rulesRevision;
    inheritResources = resources.inheritResources !== false;
    canSetInheritance = resources.canInheritResources === true && resourceRulesEnabled && enabled &&
      data.syncState.isControlled && !site.incognito && Number.isSafeInteger(resourceRevision);
    el.inheritResources.checked = inheritResources;
    el.directResources.checked = !inheritResources;
    const inheritanceHelp = !resourceRulesEnabled
      ? t('popupResourceRulesDisabled', 'Правила сайтов отключены. Включите их в настройках, чтобы назначать прокси ресурсам.')
      : resources.canInheritResources !== true || site.incognito
        ? t('popupResourceInheritanceUnavailable', 'Доступно с собственным прокси, Tor или WARP в обычной вкладке.')
        : t('popupResourceInheritanceHelp', '«Как у сайта»: автоматические ресурсы наследуют маршрут основного домена. «Без прокси»: идут напрямую. Ручные исключения сохраняются.');
    const inheritanceDetails = [inheritanceHelp,
      resources.routing === 'domains' ? t('popupResourceInheritanceChromiumScope', 'В Chromium настройка применяется к обнаруженным доменам ресурсов. Первый запрос к неизвестному домену обрабатывается PAC. После изменения перезагрузите сайт.') : '',
      t('popupResourceInheritanceDomainScope', 'Запросы к самому домену сайта используют его маршрут: отделить их от основного домена нельзя.')].filter(Boolean).join('\n');
    el.inheritResources.title = el.directResources.title = el.resourceMode.title = inheritanceDetails;
    el.inheritResources.setAttribute('aria-description', inheritanceDetails);
    el.directResources.setAttribute('aria-description', inheritanceDetails);
    siteSelect.dataset.rulesRevision = String(resourceRevision ?? '');
    const ownProxy = ['tab', 'domains'].includes(resources.routing);
    wholeSite = ownProxy && inheritResources && (!site.incognito || resources.routing === 'tab');
    el.actionScope.textContent = !inheritResources ? t('popupResourceInheritanceOff', 'Автоматические ресурсы идут напрямую. Ручные правила ресурсов сохраняются.') :
      resources.routing === 'tab' ? t("msg_for_the_whole_tab_the_page_videos_images_and__3ce1328f", "Для всей вкладки: страницы, видео, изображений и других ресурсов.") :
      wholeSite ? t("msg_for_the_site_and_detected_resources_resource__f49ef3e9", "Для сайта и найденных ресурсов. Правила ресурсов общие для всех сайтов.") :
        site.incognito ? t("msg_in_a_private_window_only_the_site_rule_change_2f20c3da", "В приватном окне меняется правило сайта. Список ресурсов не собирается.") : t("msg_only_the_main_site_domain_rule_changes_28b6eb6c", "Меняется правило основного домена сайта.");
    const limits = [];
    if (data.pacMods.ifProxyHttpsUrlsOnly) limits.push(t("msg_https_only_84ba77b3", "только HTTPS"));
    if (data.pacMods.ifMindWhitelist) limits.push(t("msg_allowlist_5d2e3dbd", "белый список"));
    if (limits.length) el.actionScope.textContent += t("msg_restrictions_sub_requests_outside_these_restr_190f99dc", " Ограничения: $1. Запросы вне этих ограничений идут напрямую.", [limits.join(', ')]);
    el.route.textContent = !match.matched ? t('fidelity_route_pac', 'Маршрут выбирает PAC') :
      match.isProxied ? (wholeSite ? t('fidelity_route_resources_proxy', 'Сайт и ресурсы — через прокси') : t('fidelity_route_proxy', 'Сайт — через прокси')) :
        (wholeSite ? t('fidelity_route_resources_direct', 'Сайт и ресурсы — напрямую') : t('fidelity_route_direct', 'Сайт — напрямую'));
    const observed = data.currentSiteRoute;
    el.reload.hidden = !enabled || !(resources.needsReload || resourceReloadNeeded) || Boolean(data.settingsState?.pending);
    el.reloadRow.hidden = el.reload.hidden;
    const sources = { auto: t("msg_resource_added_automatically_efd98e94", "Ресурс добавлен автоматически"), site: t("msg_mode_selected_for_this_site_dce783da", "Режим выбран для сайта"), import: t("msg_rule_imported_from_a_file_45ed3e33", "Правило из файла"), manual: t("msg_manual_rule_908be428", "Ручное правило") };
    el.source.textContent = match.matched ? sources[data.currentRuleSource?.source] || t("msg_saved_rule_c9b76410", "Сохранённое правило") : t("msg_the_selected_pac_script_determines_the_route_dd621449", "Маршрут определяет выбранный PAC-скрипт.");
    if (observed?.confidence === 'observed' && !resources.needsReload) {
      el.source.textContent += t("msg_last_connection_sub_869f5c83", " · последнее соединение: $1", [observed.kind === 'direct' ? t("msg_direct_f9efbd77", "напрямую") : t("msg_proxy_3a377386", "прокси")]);
    }
    const hosts = (resources.hosts || []).filter(host => host !== site.rootDomain && host !== site.fullHost);
    el.resourceCount.textContent = hosts.length;
    el.resources.replaceChildren(...hosts.map(host => {
      const item = document.createElement('li');
      const route = resourceRoutes[host] || {};
      item.dataset.origin = route.origin || '';
      const domain = resourceDomainLabel(host, route);
      const select = resourceProxySelect(host, route, data.pacMods.proxyCatalog || [], changeResourceProxy);
      item.append(domain, proxySelectControl(select));
      return item;
    }));
    el.resourcesEmpty.hidden = Boolean(hosts.length);
    el.resourcesEmpty.textContent = site.incognito ? t("msg_resources_from_private_tabs_are_not_retained_49478bdd", "В приватной вкладке список ресурсов не сохраняется.") : t("msg_resources_will_appear_as_the_site_loads_reloa_85f0af8b", "Ресурсы появятся по мере загрузки сайта. При необходимости перезагрузите его.");
    el.scope.textContent = t('popupResourceProxyScope', 'Ручные исключения для этого домена действуют во всех вкладках.');
    if (resources.limited) el.scope.textContent += t("msg_resource_list_limit_reached_b433753d", " Достигнут предел списка ресурсов.");
    if (!resourceRulesEnabled) {
      el.scope.textContent = t('popupResourceRulesDisabled', 'Правила сайтов отключены. Включите их в настройках, чтобы назначать прокси ресурсам.');
    }
    if (resources.error) el.scope.textContent += ` ${resources.error}`;
    updateRouteHint();
    el.connectionHelp.hidden = enabled && ownProxy && data.syncState.isControlled;
    el.connectionHint.textContent = !enabled ? t("msg_the_extension_is_disabled_rules_are_saved_and_f8a8c3eb", "Расширение отключено. Правила сохранятся и начнут работать после включения PAC.") :
      !data.syncState.isControlled ? t("msg_no_proxy_control_check_permissions_and_pac_se_3133dd91", "Нет управления прокси. Проверьте разрешения и настройки PAC; возможно, прокси управляет другое расширение.") :
        t("msg_connect_your_own_proxy_tor_or_warp_to_switch__1e9285d7", "Для переключения сайта вместе с ресурсами подключите свой прокси, Tor или WARP.");
    el.connectionSettings.dataset.section = !enabled || !data.syncState.isControlled ? 'pac' : 'proxies';
    el.connectionSettings.textContent = !enabled ? t("msg_select_and_enable_pac_dcc3153b", "Выбрать и включить PAC") : !data.syncState.isControlled ? t("msg_check_connection_d6d828dc", "Проверить подключение") : t("msg_set_up_your_proxy_4c80bb5f", "Настроить свой прокси");
  }

  setBusy(busy);
}

function restoreRouteFocus(previous, target, select) {
  const active = document.activeElement;
  if (previous && (active === document.body || active === previous) && sameSite(site, target) && select && !select.disabled) {
    select.focus({ preventScroll: true });
  }
}

async function changeResourceProxy(host, proxyId) {
  if (!site || busy || !el.loadError.hidden || !proxyId || !resourceRulesEnabled) return;
  const reset = proxyId === RESET_RESOURCE_ROUTE;
  if (reset && (site.incognito || !resourceRoutes[host]?.canResetExact)) return;
  const active = document.activeElement;
  const focused = active?.dataset.host === host && el.resources.contains(active) ? active : null;
  const target = { ...site };
  const expectedRevision = resourceRevision;
  revision++;
  setBusy(true);
  notice(t('msg_saving_mode_ad4188d7', 'Сохраняем режим…'), true);
  try {
    const current = await activeSite();
    if (!sameSite(current, target)) {
      notice(t('msg_the_tab_has_moved_to_another_site_data_refres_bb5e32a9', 'Вкладка сменила сайт. Данные обновлены.'));
      return;
    }
    const direct = proxyId === DIRECT_RESOURCE_ROUTE;
    const operation = direct ? { domain: host, mode: 'direct' } : { domain: host, mode: 'proxy', proxyId };
    const response = await sendMessage(reset ? { action: 'RESET_RESOURCE_RULE', host, domain: target.rootDomain,
      currentTabId: target.tabId, expectedHost: target.fullHost, expectedRevision } :
      { action: 'MUTATE_DOMAIN_RULES', operations: [operation], expectedRevision });
    if (!response.success) { notice(response.error); return; }
    resourceReloadNeeded = true;
    notice(response.settingsState?.pending ? t('msg_rules_saved_retry_applying_them_above_5418bae1', 'Правила сохранены. Для применения повторите попытку выше.') :
      !enabled ? t('msg_rules_saved_enable_pac_to_use_them_7e89fefb', 'Правила сохранены. Для работы включите PAC.') :
        reset ? t('popupResourceResetSaved', 'Точное правило сброшено. Перезагрузите сайт, чтобы обновить соединения.') :
        t('msg_sub_sub_reload_the_site_to_refresh_connection_41fb1aff', '$1: $2. Перезагрузите сайт, чтобы обновить соединения.',
          [host, direct ? t('msg_direct_f9efbd77', 'напрямую') : t('msg_via_proxy_64f51a1b', 'через прокси')]), true);
  } catch (error) { notice(error.message); }
  finally {
    await refresh().catch(showLoadError);
    setBusy(false);
    const select = [...el.resources.querySelectorAll('select')].find(node => node.dataset.host === host);
    restoreRouteFocus(focused, target, select);
  }
}

async function changeResourceInheritance(requested) {
  if (!site || busy || !el.loadError.hidden || !canSetInheritance) return;
  const target = { ...site };
  const expectedRevision = resourceRevision;
  revision++;
  setBusy(true);
  notice(t('msg_saving_mode_ad4188d7', 'Сохраняем режим…'), true);
  try {
    if (!sameSite(await activeSite(), target)) {
      notice(t('msg_the_tab_has_moved_to_another_site_data_refres_bb5e32a9', 'Вкладка сменила сайт. Данные обновлены.'));
      return;
    }
    const response = await sendMessage({ action: 'SET_SITE_RESOURCE_INHERITANCE', domain: target.rootDomain,
      currentTabId: target.tabId, enabled: requested, expectedRevision, expectedHost: target.fullHost });
    if (!response.success) { notice(response.error); return; }
    resourceReloadNeeded = true;
    notice(response.settingsState?.pending ? t('msg_rules_saved_retry_applying_them_above_5418bae1', 'Правила сохранены. Для применения повторите попытку выше.') :
      t('popupResourceInheritanceSaved', 'Настройка ресурсов сохранена. Перезагрузите сайт, чтобы обновить соединения.'), true);
  } catch (error) { notice(error.message); }
  finally { await refresh().catch(showLoadError); setBusy(false); }
}

async function changeSiteMode(mode, proxyId) {
  if (!site || busy || !el.loadError.hidden) return;
  const active = document.activeElement;
  const focused = active === el.siteProxyWrap.querySelector('select') ? active : null;
  revision++;
  const target = { ...site };
  const includeResources = wholeSite;
  const expectedRevision = resourceRevision;
  setBusy(true);
  notice(t("msg_saving_mode_ad4188d7", "Сохраняем режим…"), true);
  try {
    const current = await activeSite();
    if (!sameSite(current, target)) {
      notice(t('msg_the_tab_has_moved_to_another_site_data_refres_bb5e32a9', 'Вкладка сменила сайт. Данные обновлены.'));
      return;
    }
    const response = await sendMessage({ action: 'SET_SITE_ROUTE', domain: target.rootDomain, currentTabId: target.tabId,
      isProxy: mode === 'pac' ? null : mode === 'proxy',
      ...(mode === 'proxy' && proxyId ? { proxyId } : {}), expectedRevision, expectedHost: target.fullHost });
    if (!response.success) { notice(response.error); return; }
    resourceReloadNeeded = true;
    const selected = mode === 'pac' ? t("msg_pac_rules_203bc29a", "по PAC") : mode === 'proxy' ? t("msg_via_proxy_64f51a1b", "через прокси") : t("msg_direct_f9efbd77", "напрямую");
    notice(response.settingsState?.pending ? t("msg_rules_saved_retry_applying_them_above_5418bae1", "Правила сохранены. Для применения повторите попытку выше.") :
      !enabled ? t("msg_rules_saved_enable_pac_to_use_them_7e89fefb", "Правила сохранены. Для работы включите PAC.") :
        t("msg_sub_sub_reload_the_site_to_refresh_connection_41fb1aff", "$1: $2. Перезагрузите сайт, чтобы обновить соединения.", [includeResources ? t("msg_site_and_resources_9dcdb919", "Сайт и ресурсы") : t("msg_site_b4541abd", "Сайт"), selected]), true);
  } catch (error) { notice(error.message); }
  finally {
    await refresh().catch(showLoadError);
    setBusy(false);
    const select = el.siteProxyWrap.querySelector('select');
    restoreRouteFocus(focused, target, select);
  }
}

for (const input of [el.inheritResources, el.directResources]) input.addEventListener('change', async () => {
  const requested = input === el.inheritResources;
  const changed = input.checked;
  const focused = document.activeElement === input;
  const target = site;
  el.inheritResources.checked = inheritResources;
  el.directResources.checked = !inheritResources;
  if (changed) await changeResourceInheritance(requested);
  const selected = inheritResources ? el.inheritResources : el.directResources;
  restoreRouteFocus(focused ? input : null, target, selected);
});
el.reload.addEventListener('click', async () => {
  if (!site || busy || applicationPending || !el.loadError.hidden) return;
  revision++;
  const target = { ...site };
  let closing = false;
  setBusy(true);
  try {
    const current = await activeSite();
    if (!sameSite(current, target)) {
      notice(t("msg_the_tab_has_moved_to_another_site_data_refres_bb5e32a9", "Вкладка сменила сайт. Данные обновлены."));
      await refresh().catch(showLoadError);
      return;
    }
    const error = await new Promise(resolve => chrome.tabs.reload(target.tabId, {}, () => resolve(chrome.runtime.lastError?.message || '')));
    if (error) notice(error);
    else { closing = true; window.close(); }
  } catch (error) { notice(error.message); }
  finally { if (!closing) setBusy(false); }
});

el.retryLoad.addEventListener('click', () => refresh().catch(showLoadError));
document.addEventListener('focusout', event => {
  if (storageRefreshPending && event.target.matches('select')) scheduleStorageRefresh();
});
for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => openSettings(button.dataset.section));
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && (changes['pac-kitchen-mods'] || changes['settings-application'] || changes.antiCensorRu)) ||
      (area === 'session' && changes['site-resource-tabs'])) {
    scheduleStorageRefresh();
  }
});
refresh().catch(showLoadError);
