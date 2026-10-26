'use strict';

import { getRootDomain } from './utils.js';

export const RKN_BLOCKLIST_URL = 'https://blocklist.rkn.gov.ru/';
export const RKN_PREFILL_FRAGMENT_KEY = 'anticheburnet-search';

export function normalizeRknLookupDomain(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return '';

  try {
    const value = rawValue.trim();
    if (!value) return '';
    const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const parsed = new URL(hasExplicitScheme ? value : `https://${value}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!hostname) return '';
    return getRootDomain(hostname) || hostname;
  } catch {
    return '';
  }
}

export function buildRknBlocklistUrl(rawValue) {
  const lookupDomain = normalizeRknLookupDomain(rawValue);
  if (!lookupDomain) return RKN_BLOCKLIST_URL;

  const fragment = `${RKN_PREFILL_FRAGMENT_KEY}=${encodeURIComponent(lookupDomain)}`;
  return `${RKN_BLOCKLIST_URL}#${fragment}`;
}
