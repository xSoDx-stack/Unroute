// The controller replaces the snapshot arrays/objects rather than mutating them.
// Keep display order separate from the source order used by the raw editor.
export function createDomainCardIndex({ exceptions, whitelist, pacBypassDomains }) {
  const tabs = { included: [], excluded: [], whitelist, pac: pacBypassDomains };
  for (const domain of Object.keys(exceptions)) {
    if (exceptions[domain] === true) tabs.included.push(domain);
    else if (exceptions[domain] === false) tabs.excluded.push(domain);
  }
  const sorted = new Map();
  return {
    count: tab => tabs[tab].length,
    filter(tab, { query, source, proxy, ruleMeta, domainProxyIds }) {
      if (!sorted.has(tab)) sorted.set(tab, [...tabs[tab]].sort());
      const items = sorted.get(tab);
      if (!query && !source && !proxy) return items;
      const prefix = tab === 'whitelist' ? 'whitelist:' : 'exception:';
      return items.filter(domain => (!query || domain.toLowerCase().includes(query)) &&
        (!source || ruleMeta[prefix + domain]?.source === source) &&
        (!proxy || (proxy === 'legacy' ? !domainProxyIds[domain] : domainProxyIds[domain] === proxy)));
    },
  };
}
