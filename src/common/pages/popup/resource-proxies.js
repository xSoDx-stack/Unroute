'use strict';

import { t } from '../../core/i18n.js';

export const DIRECT_RESOURCE_ROUTE = '@direct';
export const RESET_RESOURCE_ROUTE = '@reset-exact';
export const PAC_SITE_ROUTE = '@pac';
export const AUTOMATIC_RESOURCE_ROUTE = '@automatic';
const nameSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function resourceOriginHelp(route = {}) {
  switch (route.origin) {
    case 'manual': return t('popupResourceManual', 'Ручное правило $1. Не меняется вместе с сайтом.', [route.ruleKey || '']);
    case 'site': return t('popupResourceAutomatic', 'Следует общей настройке ресурсов сайта.');
    case 'main': return t('popupResourceMain', 'Основной домен: его запросы используют маршрут сайта.');
    case 'automatic-other': return t('popupResourceOtherAuto', 'Автоматическое глобальное правило ресурса другого сайта.');
    case 'pac': return t('popupResourcePac', 'Маршрут определяет PAC; отдельного ручного правила ресурса нет.');
    default: return '';
  }
}

export function resourceDomainLabel(host, route = {}) {
  const label = document.createElement('span');
  label.className = 'resource-host';
  label.title = resourceOriginHelp(route);
  const domain = document.createElement('span');
  domain.className = 'resource-domain';
  domain.textContent = host;
  label.append(domain);
  if (route.origin === 'manual') {
    const pin = document.createElement('span');
    pin.className = 'resource-manual';
    pin.setAttribute('role', 'img');
    pin.setAttribute('aria-label', label.title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['m16 3 5 5-4 1-4 4-1 4-5-5 4-1 4-4z', 'm7 17-4 4']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    pin.append(svg);
    label.append(pin);
  }
  return label;
}

// Keep the native menu and accessible option names intact; shorten only the
// closed control, so profiles sharing a prefix can still be distinguished.
export function proxySelectControl(select) {
  const name = select.dataset.proxyName;
  if (!name) return select;
  const characters = Array.from(nameSegments.segment(name), item => item.segment);
  if (characters.length <= 6) return select;
  const control = document.createElement('span');
  control.className = 'proxy-name-control';
  const label = document.createElement('span');
  label.className = 'proxy-name-label';
  label.setAttribute('aria-hidden', 'true');
  label.textContent = characters.slice(0, 5).join('') + '…';
  control.append(select, label);
  return control;
}

export function siteRouteSelect(host, route = {}, catalog, onChange) {
  const select = document.createElement('select');
  select.id = 'siteRoute';
  select.className = 'site-proxy';
  select.setAttribute('aria-describedby', 'actionScope');
  select.setAttribute('aria-label', `${t('popupSiteConnection', 'Подключение сайта')}: ${host}`);
  select.add(new Option(t('popupSiteAutomatic', 'Автоматически — по PAC'), PAC_SITE_ROUTE));
  select.add(new Option(t('popupWithoutProxy', 'Без прокси'), DIRECT_RESOURCE_ROUTE));
  const targets = catalog.filter(proxy => proxy.enabled);
  const assigned = route.mode === 'proxy' ? route.proxyId || '@legacy' : route.mode === 'direct' ? DIRECT_RESOURCE_ROUTE : PAC_SITE_ROUTE;
  if (route.mode === 'proxy' && !targets.some(proxy => proxy.id === assigned)) {
    const option = new Option(route.proxyId ? t('mpMissingProxy', 'Прокси недоступен') :
      t('popupLegacyProxyList', 'Общий список прокси'), assigned);
    option.disabled = true;
    select.add(option);
  }
  for (const proxy of targets) select.add(new Option(t('popupSiteProxyChoice', 'Прокси: $1', [proxy.name]), proxy.id));
  select.value = assigned;
  select.title = route.mode === 'proxy' && !route.proxyId
    ? t('popupLegacyProxyHelp', 'Правило без привязки к конкретному прокси: используется общий список прокси, а не прямое соединение.')
    : select.selectedOptions[0].textContent;
  select.addEventListener('change', () => {
    const requested = select.value;
    const selectable = Boolean(select.selectedOptions[0] && !select.selectedOptions[0].disabled);
    select.value = assigned;
    if (selectable) onChange(requested);
  });
  return select;
}

// Effective routes come from the background, including Firefox tab inheritance.
// Never infer an assignment from the catalog order or the default profile.
export function resourceProxySelect(host, route = {}, catalog, onChange) {
  const targets = catalog.filter(proxy => proxy.enabled);
  const select = document.createElement('select');
  select.className = 'resource-proxy';
  select.dataset.host = host;
  select.setAttribute('aria-label', t('popupResourceRouteLabel', 'Маршрут для $1', [host]));
  const selectedProxy = targets.find(proxy => proxy.id === route.proxyId);
  const missing = route.mode === 'proxy' && route.proxyId && !selectedProxy;
  const automatic = ['site', 'pac', 'automatic-other'].includes(route.origin) && !missing;
  const isDirect = route.mode === 'direct';
  const assigned = automatic ? AUTOMATIC_RESOURCE_ROUTE : isDirect ? DIRECT_RESOURCE_ROUTE : route.proxyId || '';
  if (automatic) {
    const option = new Option(t('popupResourceAutoChoice', 'Автоматически'), AUTOMATIC_RESOURCE_ROUTE);
    option.disabled = true;
    select.add(option);
  } else if (!isDirect && (!assigned || !selectedProxy)) {
    const label = assigned ? t('mpMissingProxy', 'Прокси недоступен') :
      route.mode === 'proxy' ? t('popupLegacyProxyList', 'Общий список прокси') : 'PAC';
    const placeholder = new Option(label, assigned, true, true);
    placeholder.disabled = true;
    select.add(placeholder);
  }
  select.add(new Option(t('popupWithoutProxy', 'Без прокси'), DIRECT_RESOURCE_ROUTE));
  for (const proxy of targets) select.add(new Option(proxy.name, proxy.id));
  let resetHelp;
  if (route.canResetExact) {
    const reset = new Option(t('popupResourceReset', 'Убрать исключение'), RESET_RESOURCE_ROUTE);
    resetHelp = t('popupResourceResetHelp', 'Удаляется только ручное правило этого точного домена. Оставшиеся wildcard-правила сохраняются; иначе действует настройка ресурсов сайта.');
    reset.title = resetHelp;
    reset.setAttribute('aria-description', resetHelp);
    select.add(reset);
  }
  select.value = assigned;
  if (!automatic && selectedProxy) {
    select.dataset.proxyName = selectedProxy.name;
  }
  const actual = isDirect ? t('popupWithoutProxy', 'Без прокси') : route.mode === 'proxy' ?
    (selectedProxy?.name || (route.proxyId ? t('mpMissingProxy', 'Прокси недоступен') : t('popupLegacyProxyList', 'Общий список прокси'))) :
    t('popupSiteAutomatic', 'Автоматически — по PAC');
  const configured = t('popupConfiguredRoute', 'Настроено: $1', [actual]);
  const originHelp = resourceOriginHelp(route);
  const legacyHelp = route.mode === 'proxy' && !route.proxyId ?
    t('popupLegacyProxyHelp', 'Правило без привязки к конкретному прокси: используется общий список прокси, а не прямое соединение.') : '';
  const scope = t('popupResourceProxyScope', 'Ручные исключения для этого домена действуют во всех вкладках.');
  select.title = [configured, originHelp, scope, legacyHelp, resetHelp].filter(Boolean).join('\n');
  select.setAttribute('aria-description', select.title);

  select.addEventListener('change', () => {
    const requested = select.value;
    const selectable = Boolean(select.selectedOptions[0] && !select.selectedOptions[0].disabled);
    // Keep the last confirmed route visible until the state read succeeds,
    // including when both the mutation and its recovery refresh fail.
    select.value = assigned;
    if (selectable) onChange(host, requested);
  });
  return select;
}
