'use strict';

import { getRootDomain } from './utils.js';

export function siteFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || !host.includes('.') || /^[\d.]+$/.test(host) ||
        host.includes(':') || /\.(?:localhost|local|internal)$/.test(host)) return null;
    return { fullHost: host, rootDomain: getRootDomain(host) || host };
  } catch { return null; }
}
