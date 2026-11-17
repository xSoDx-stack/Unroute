'use strict';

import { normalizeDomainRule } from './domain-rules.js';
import { getDomain } from '../vendor/tldts.esm.js';

export function isCanonicalSiteRoot(domain) {
  if (typeof domain !== 'string' || !domain.includes('.') || domain.includes('*') ||
      /^[\d.]+$/.test(domain) || /\.(?:local|localhost|internal)$/.test(domain)) return false;
  const normalized = normalizeDomainRule(domain, { allowWildcard: false });
  return normalized.valid && normalized.domain === domain && getDomain(domain, { allowPrivateDomains: true }) === domain;
}

export function sanitizeSiteResourceInheritance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([domain, enabled]) => enabled === false && isCanonicalSiteRoot(domain)));
}

export function inheritsSiteResources(mods, root) {
  return !Object.hasOwn(mods.siteResourceInheritance || {}, root) || mods.siteResourceInheritance[root] !== false;
}
