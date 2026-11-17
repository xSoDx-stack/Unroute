'use strict';

import { siteFromUrl } from '../../core/site-context.js';
export { siteFromUrl } from '../../core/site-context.js';

export async function activeSite() {
  const tabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
  const tab = tabs?.[0];
  const site = siteFromUrl(tab?.url);
  return site ? { ...site, tabId: tab.id, incognito: Boolean(tab.incognito) } : null;
}
