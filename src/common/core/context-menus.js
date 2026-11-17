'use strict';

import { t, uiLocale } from './i18n.js';

const MENU_ITEMS = [
  {
    id: 'google-translate',
    title: t("msg_open_with_google_translate_5c98f6aa", "Через Google Translate"),
    getUrl: (url) => `https://translate.google.com/translate?hl=${uiLocale()}&sl=auto&tl=${uiLocale().split('-')[0]}&anno=2&sandbox=1&u=${encodeURIComponent(url)}`,
  },
];

export function createContextMenuItems() {
  if (!chrome.contextMenus) return;

  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: ['action'],
      }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
  });
}

export function setupContextMenus() {
  if (!chrome.contextMenus) return;

  const onClicked = chrome.contextMenus.onClicked;
  if (!onClicked || typeof onClicked.addListener !== 'function') return;
  if (typeof onClicked.hasListener === 'function' && onClicked.hasListener(handleMenuClick)) {
    return;
  }
  onClicked.addListener(handleMenuClick);
}

function handleMenuClick(info, tab) {
  const item = MENU_ITEMS.find((menuItem) => menuItem.id === info.menuItemId);
  if (!item) return;

  // This action deliberately shares a page with a third party. Never send
  // internal URLs or credentials; reject rather than silently stripping them.
  let page;
  try { page = new URL(tab?.url); } catch { return; }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) return;
  const targetUrl = item.getUrl(page.href);
  if (targetUrl) {
    chrome.tabs.create({ url: targetUrl });
  }
}
