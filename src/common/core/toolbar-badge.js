'use strict';

import { t } from './i18n.js';
import { appState } from './app-state.js';
import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import { settingsCoordinator } from './settings-coordinator.js';
import { matchConfiguredRule } from './domain-route-resolver.js';
import { siteFromUrl } from './site-context.js';

export function badgePresentation(url, { sync, mods, application }) {
  const brand = t('msg_unroute_494f900b', 'Unroute');
  if (!sync.currentPacProviderKey || sync.currentPacProviderKey === 'none') {
    return { text: '', color: '#334155', title: `${brand} — ${t('msg_disabled_3e958000', 'Отключено')}` };
  }
  if (application.pending && application.error && !application.applying) {
    return { text: '!', color: '#9b302f', title: t('badgeApplyError', 'Unroute — ошибка применения настроек. Откройте расширение.') };
  }
  if (['controlled_by_other_extensions', 'not_controllable'].includes(sync.levelOfControl)) {
    return { text: '!', color: '#9b302f', title: `${brand}\n${t('msg_no_proxy_control_check_permissions_and_pac_se_3133dd91',
      'Нет управления прокси. Проверьте разрешения и настройки PAC; возможно, прокси управляет другое расширение.')}` };
  }
  const site = siteFromUrl(url);
  if (!site) return { text: '', color: '#334155', title: brand };
  // Resolve the actual top-level host, not just its registrable root: manual
  // subdomain rules and materialized resource provenance have different owners.
  const match = matchConfiguredRule(site.fullHost, mods);
  let text = 'PAC';
  let color = '#59408f';
  let label = t('msg_pac_rules_203bc29a', 'по PAC');
  if (match.matched && !match.isPac) {
    text = match.isProxied ? 'P' : 'D';
    color = match.isProxied ? '#07566a' : '#334155';
    label = match.isProxied ? t('msg_via_proxy_64f51a1b', 'через прокси') : t('msg_direct_f9efbd77', 'напрямую');
  }
  return { text, color, title: `${brand}\n${site.fullHost}\n${t('msg_selected_sub_a57f6a02', 'Выбрано: $1', [label])}\n${
    t('badgeModeHint', 'Значок показывает выбранный режим сайта. Для отдельных ресурсов могут действовать свои правила и ограничения.')}` };
}

function callApi(owner, method, details) {
  return new Promise((resolve, reject) => {
    if (typeof owner?.[method] !== 'function') { resolve(); return; }
    owner[method](details, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function loadBadgeState() {
  // Restore local snapshots only. Drawing the toolbar must never reinstall PAC.
  await appState.ensureLocalStateInitialized();
  return { sync: pacSync.getState(), mods: await pacKitchen.getPacMods(), application: await settingsCoordinator.state() };
}

export class ToolbarBadge {
  constructor(readState = loadBadgeState) {
    this.readState = readState;
    this.presentations = new Map();
    this.timer = null;
    this.dirty = false;
    this.running = false;
    this.registered = false;
  }

  schedule() {
    this.dirty = true;
    if (this.timer !== null || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch(error => console.warn('[Toolbar badge]', error.message));
    }, 50);
  }

  async refresh() {
    if (this.running) { this.dirty = true; return; }
    this.running = true;
    try {
      do {
        this.dirty = false;
        const state = await this.readState();
        const tabs = await callApi(chrome.tabs, 'query', {});
        if (this.dirty) continue;
        const openIds = new Set((tabs || []).map(tab => tab.id));
        for (const id of this.presentations.keys()) {
          if (!openIds.has(id)) this.presentations.delete(id);
        }
        await Promise.all((tabs || []).map(async tab => {
          if (!Number.isInteger(tab.id) || tab.id < 0) return;
          const presentation = badgePresentation(tab.pendingUrl || tab.url, state);
          const signature = JSON.stringify(presentation);
          if (this.presentations.get(tab.id) === signature) return;
          try {
            await Promise.all([
              callApi(chrome.action, 'setBadgeText', { tabId: tab.id, text: presentation.text }),
              callApi(chrome.action, 'setBadgeBackgroundColor', { tabId: tab.id, color: presentation.color }),
              callApi(chrome.action, 'setBadgeTextColor', { tabId: tab.id, color: '#ffffff' }),
              callApi(chrome.action, 'setTitle', { tabId: tab.id, title: presentation.title }),
            ]);
            if (!this.dirty) this.presentations.set(tab.id, signature);
          } catch {
            this.presentations.delete(tab.id);
          }
        }));
      } while (this.dirty);
    } finally { this.running = false; }
  }

  setup() {
    if (this.registered) return;
    this.registered = true;
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (change.url || change.status === 'loading' || change.status === 'complete') {
        // Browsers reset tab-specific action properties on navigation.
        this.presentations.delete(id);
        this.schedule();
      }
    });
    chrome.tabs.onActivated.addListener(() => this.schedule());
    chrome.tabs.onCreated.addListener(() => this.schedule());
    chrome.tabs.onRemoved.addListener(id => this.presentations.delete(id));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes['pac-kitchen-mods'] || changes['settings-application'] ||
          changes.antiCensorRu || changes['handlers-state'])) this.schedule();
    });
    this.schedule();
  }
}

export const toolbarBadge = new ToolbarBadge();
