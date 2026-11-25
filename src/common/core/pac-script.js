'use strict';

import { routeConstraint, compilePolicy } from './routing-policy.js';
import { compileConfiguredRules, matchCompiledRules } from './domain-route-resolver.js';

const KITCHEN_STARTS_MARK = '//%#@@@@@@ PAC_KITCHEN_STARTS @@@@@@#%';
const previousWrapper = new RegExp(`(?:\\r?\\n){2}${KITCHEN_STARTS_MARK}[\\s\\S]*$`);

// Also embedded in the PAC to parse the source PAC's per-request result.
function appendProxyDirectives(chain, directives, secureOnly) {
  if (!chain) return;
  for (const part of chain.split(/(?:\s*;\s*)+/g)) {
    const directive = part.trim();
    if (directive && (secureOnly ? /^HTTPS\s/i.test(directive) : !/^DIRECT$/i.test(directive))) {
      directives.push(directive);
    }
  }
}

export function cookPac(pacData, pacMods) {
  if (!pacData) return '';
  pacData = pacData.replace(previousWrapper, '').trim();

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

  const ifProxyOrDie = pacMods.ifProxyOrDie !== false;
  const ownProxyOrDie = pacMods.ownProxyOrDie !== false;
  const failClosedProxy = 'PROXY 127.0.0.1:0';
  const customDirectives = [];
  appendProxyDirectives(pacMods.filteredCustomsString, customDirectives);
  const reserveDirectives = (pacMods.fallbackProxyChain || '').split(/\s*;\s*/)
    .filter(directive => directive && !/^DIRECT$/i.test(directive));
  const torDirectives = [];
  const useTor = pacMods.ifUseLocalTor && pacMods.torPoints;
  if (useTor) for (const chain of pacMods.torPoints) appendProxyDirectives(chain, torDirectives);

  let generatedPac = `\n\n${KITCHEN_STARTS_MARK}
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
  const failClosedProxy = ${JSON.stringify(failClosedProxy)};
  const ifProxyOrDie = ${ifProxyOrDie};
  const ownProxyOrDie = ${ownProxyOrDie};
  const customDirectives = ${JSON.stringify(customDirectives)};
  const reserveDirectives = ${JSON.stringify(reserveDirectives)};
  const appendDirectives = ${appendProxyDirectives.toString()};
  ${useTor ? `const torRoute = ${JSON.stringify(torDirectives.join('; ') || failClosedProxy)};` : ''}

  function formatProxyChain(directives, mustProxy, ownRoute) {
    const strict = ownRoute ? ownProxyOrDie : ifProxyOrDie;
    if (directives.length === 0) return mustProxy && strict ? failClosedProxy : "DIRECT";

    // Browsers try the reserve only after the selected route fails. DIRECT
    // routes return above; credentials have already been stripped by cooking.
    if (ownRoute) {
      for (const directive of reserveDirectives) {
        if (directives.indexOf(directive) < 0) directives.push(directive);
      }
    }
    return directives.join("; ") + (strict ? "" : "; DIRECT");
  }

  function getCustomProxiedDestination(url, host, ruleKey, proxyId) {
    if (proxyId !== undefined || Object.prototype.hasOwnProperty.call(domainProxyIds, ruleKey)) {
      explicitDirect = true; // Assigned fallback must not become another profile.
      const id = proxyId !== undefined ? proxyId : domainProxyIds[ruleKey];
      const chain = Object.prototype.hasOwnProperty.call(proxyRoutes, id) ? proxyRoutes[id] : null;
      if (!chain) return 'PROXY 127.0.0.1:9';
      const directives = [];
      appendDirectives(chain, directives);
      return formatProxyChain(directives, true, true);
    }
    ${useTor ? `if (/\\.onion\\.*$/i.test(host)) return torRoute;` : ''}
    const directives = customDirectives.slice();
    ${pacMods.ifUsePacScriptProxies && !pacMods.ifUseOwnProxiesOnlyForOwnSites ? `
    const pacRes = originalFindProxyForURL(url, host);
    if (pacRes && !/^DIRECT$/i.test(pacRes.trim())) {
      appendDirectives(pacRes, directives, ${Boolean(pacMods.ifUseSecureProxiesOnly)});
    }
    ` : ''}
    // With PAC proxies enabled, a manually added host without a source route
    // falls back to DIRECT rather than flooding chrome.proxy.onProxyError.
    return formatProxyChain(directives, ${!pacMods.ifUsePacScriptProxies}, true);
  }

  let tmp = function(url, host) {
    explicitDirect = false;
    if (checkConstraint(url, host, policy, allowedHosts)) {
      explicitDirect = true;
      return 'DIRECT';
    }
    const configuredMatch = matchConfigured(host, configuredRules);
    if (configuredMatch.matched && !configuredMatch.isPac) {
      explicitDirect = !configuredMatch.isProxied;
      return configuredMatch.isProxied ? getCustomProxiedDestination(url, host,
        configuredMatch.ruleKey, configuredMatch.proxyId) : "DIRECT";
    }
    ${useTor ? `if (/\\.onion\\.*$/i.test(host)) return torRoute;` : ''}
    const pacRes = originalFindProxyForURL(url, host);
    if (!pacRes || /^DIRECT$/i.test(pacRes.trim())) {
      return "DIRECT";
    }

    const candidates = ${pacMods.ifUseOwnProxiesOnlyForOwnSites ? '[]' : 'customDirectives.slice()'};
    ${pacMods.ifUsePacScriptProxies ? `appendDirectives(pacRes, candidates, ${Boolean(pacMods.ifUseSecureProxiesOnly)});` : ''}
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
