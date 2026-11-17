'use strict';

import { routeConstraint, compilePolicy } from './routing-policy.js';
import { compileConfiguredRules, matchCompiledRules } from './domain-route-resolver.js';

const KITCHEN_STARTS_MARK = '\n\n//%#@@@@@@ PAC_KITCHEN_STARTS @@@@@@#%';

export function cookPac(pacData, pacMods) {
  if (!pacData) return '';
  pacData = pacData.replace(new RegExp(KITCHEN_STARTS_MARK + '[\\s\\S]*$', 'g'), '').trim();

  // The default Proxy Or Die policy still requires the safety wrapper.
  if (pacMods.ifNoMods && pacMods.ifProxyOrDie === false) {
    return pacData;
  }

  const missingOriginalFallback = pacMods.ifProxyOrDie !== false
    ? 'PROXY 127.0.0.1:0'
    : 'DIRECT';
  const compiledPolicy = compilePolicy(pacMods);
  const finalExceptions = {};
  if (pacMods.ifProxyMoreDomains && pacMods.moreDomains) {
    for (const tld of pacMods.moreDomains) finalExceptions['*.' + tld] = true;
  }
  if (pacMods.ifMindExceptions && pacMods.exceptions) Object.assign(finalExceptions, pacMods.exceptions);

  const configured = compileConfiguredRules({ ...pacMods, exceptions: finalExceptions,
    ...(pacMods.ifMindExceptions && !pacMods.ifNoMods ? {} : { domainLists: [], pacBypassDomains: [] }) });

  let generatedPac = `${KITCHEN_STARTS_MARK}
;(function(global) {
  "use strict";
  const originalFindProxyForURL = typeof FindProxyForURL === 'function'
    ? FindProxyForURL
    : function() { return ${JSON.stringify(missingOriginalFallback)}; };
  ${pacMods.ifProhibitDns ? 'global.dnsResolve = function() { return null; };' : ''}
  let explicitDirect = false;
  const checkConstraint = ${routeConstraint.toString()};
  const policy = ${JSON.stringify(compiledPolicy.policy)};
  const allowedHosts = ${JSON.stringify(compiledPolicy.whitelist)};
  // Routing tables belong to this PAC instance, not to individual requests.
  const configuredRules = ${JSON.stringify(configured)};
  const matchConfigured = ${matchCompiledRules.toString()};
  const domainProxyIds = ${JSON.stringify(pacMods.domainProxyIds || {})};
  const proxyRoutes = ${JSON.stringify(pacMods.proxyRoutes || {})};
  let tmp = function(url, host) {
    explicitDirect = false;
    if (checkConstraint(url, host, policy, allowedHosts)) {
      explicitDirect = true;
      return 'DIRECT';
    }
`;





  const ifProxyOrDie = pacMods.ifProxyOrDie !== false;
  const failClosedProxy = 'PROXY 127.0.0.1:0';

  generatedPac += `
    const failClosedProxy = ${JSON.stringify(failClosedProxy)};
    const ifProxyOrDie = ${ifProxyOrDie};

    const filteredCustomProxies = ${JSON.stringify(pacMods.filteredCustomsString || '')};

    function formatProxyChain(proxyList, isRouteMustProxy) {
      const allDirectives = [];
      (proxyList || []).forEach(function(item) {
        if (!item) return;
        item.split(/(?:\\s*;\\s*)+/g).forEach(function(p) {
          const trimmed = (p || '').trim();
          if (trimmed && !/^DIRECT$/i.test(trimmed)) {
            allDirectives.push(trimmed);
          }
        });
      });

      if (allDirectives.length === 0) {
        if (isRouteMustProxy) {
          return ifProxyOrDie ? failClosedProxy : "DIRECT";
        }
        return "DIRECT";
      }

      if (ifProxyOrDie) {
        return allDirectives.join("; ");
      } else {
        return allDirectives.join("; ") + "; DIRECT";
      }
    }

    function getCustomProxiedDestination(url, host, ruleKey, proxyId) {
      if (proxyId !== undefined || Object.prototype.hasOwnProperty.call(domainProxyIds, ruleKey)) {
        explicitDirect = true; // Assigned fallback must not become another profile.
        const id = proxyId !== undefined ? proxyId : domainProxyIds[ruleKey];
        const chain = Object.prototype.hasOwnProperty.call(proxyRoutes, id) ? proxyRoutes[id] : null;
        return chain ? formatProxyChain([chain], true) : 'PROXY 127.0.0.1:9';
      }
      ${pacMods.ifUseLocalTor && pacMods.torPoints ? `
      if (host.endsWith('.onion')) return ${JSON.stringify(pacMods.torPoints.join('; '))};
      ` : ''}
      const list = [];
      if (filteredCustomProxies) {
        list.push(filteredCustomProxies);
      }
      ${pacMods.ifUsePacScriptProxies && !pacMods.ifUseOwnProxiesOnlyForOwnSites ? `
      const pacRes = originalFindProxyForURL(url, host);
      if (pacRes && !/^DIRECT$/i.test(pacRes.trim())) {
        ${pacMods.ifUseSecureProxiesOnly ? `
        const secureOnly = pacRes.split(/(?:\\s*;\\s*)+/g).filter(function(pStr) { return /^HTTPS\\s/i.test(pStr.trim()); });
        if (secureOnly.length) list.push(secureOnly.join("; "));
        ` : `
        list.push(pacRes);
        `}
      }
      ` : ''}
      // When PAC proxies are enabled but the source PAC has no route for a
      // manually added host, there is no proxy to fail closed through. Falling
      // back to DIRECT avoids routing every request to the intentional dead
      // proxy and flooding chrome.proxy.onProxyError. Explicitly disabling PAC
      // proxies keeps the existing fail-closed behaviour.
      return formatProxyChain(list, ${!pacMods.ifUsePacScriptProxies});
    }
`;

  generatedPac += `
    const configuredMatch = matchConfigured(host, configuredRules);
    if (configuredMatch.matched && !configuredMatch.isPac) {
      explicitDirect = !configuredMatch.isProxied;
      return configuredMatch.isProxied ? getCustomProxiedDestination(url, host,
        configuredMatch.ruleKey, configuredMatch.proxyId) : "DIRECT";
    }
`;

  generatedPac += `
    ${pacMods.ifUseLocalTor && pacMods.torPoints ? `
    if (host.endsWith('.onion')) return ${JSON.stringify(pacMods.torPoints.join('; '))};
    ` : ''}
    const pacRes = originalFindProxyForURL(url, host);
    if (!pacRes || /^DIRECT$/i.test(pacRes.trim())) {
      return "DIRECT";
    }

    const candidates = [];
    ${pacMods.filteredCustomsString && !pacMods.ifUseOwnProxiesOnlyForOwnSites ? `
    candidates.push(filteredCustomProxies);
    ` : ''}

    ${pacMods.ifUsePacScriptProxies ? `
      ${pacMods.ifUseSecureProxiesOnly ? `
      const securePac = pacRes.split(/(?:\\s*;\\s*)+/g).filter(function(pStr) { return /^HTTPS\\s/i.test(pStr.trim()); });
      if (securePac.length) candidates.push(securePac.join("; "));
      ` : `
      candidates.push(pacRes);
      `}
    ` : ''}

    return formatProxyChain(candidates, true);
  };
`;

  if (pacMods.replaceDirectWith) {
    const directReplacementJson = JSON.stringify(pacMods.replaceDirectWith);
    generatedPac += `
  const directReplacement = ${directReplacementJson};
  const oldTmp = tmp;
  tmp = function(url, host) {
    const res = oldTmp.call(this, url, host);
    if (explicitDirect) return res;
    if (typeof res !== 'string') return res;
    return res.replace(/(;|^)\\s*DIRECT\\s*(?=;|$)/g, function(match, p1) {
      return (p1 ? p1 + " " : "") + directReplacement;
    });
  };
`;
  }

  generatedPac += `
  if (typeof global !== 'undefined') {
    global.FindProxyForURL = tmp;
  }
  if (typeof self !== 'undefined') {
    self.FindProxyForURL = tmp;
  }
})(this);
`;

  return pacData + generatedPac;
}
