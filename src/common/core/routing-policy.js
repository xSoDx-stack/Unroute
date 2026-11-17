'use strict';

// This pure function is also embedded into the native PAC from bundled source.
// Keep it free of module/global dependencies so both backends use one contract.
export function routeConstraint(url, host, policy, whitelist) {
  if (policy.whitelistEnabled) {
    const labels = host.split('.');
    let allowed = false;
    for (let index = 0; index < labels.length; index++) {
      if (whitelist[labels.slice(index).join('.')] === true) { allowed = true; break; }
    }
    if (!allowed) return 'whitelist';
  }
  if (policy.httpsOnly && !url.startsWith('https:')) return 'https-only';
  return '';
}

export function compilePolicy(mods) {
  return {
    policy: { whitelistEnabled: Boolean(mods.ifMindWhitelist), httpsOnly: Boolean(mods.ifProxyHttpsUrlsOnly) },
    whitelist: Object.fromEntries((mods.whitelist || []).map(host =>
      [String(host).replace(/^\*\.?/, '').replace(/^\./, ''), true])),
  };
}
