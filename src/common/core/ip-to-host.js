'use strict';

import { storage } from './storage.js';

const IP_STORAGE_KEY = 'ip-to-host';
const MAX_IP_MAP_SIZE = 500;

const DEFAULT_PROXY_IPS = {
  // Local Tor / Xray / SOCKS5 / Shadowsocks / Sing-box proxies
  '127.0.0.1': 'localhost',
  '0.0.0.0': 'localhost',
  '::1': 'localhost',

  // Known Antizapret proxy server IPs
  '195.201.201.32': 'proxy.antizapret.prostovpn.org:8443',
  '51.158.176.144': 'proxy.antizapret.prostovpn.org:8443',
  '194.58.109.112': 'proxy.antizapret.prostovpn.org:8443',
  '140.238.220.198': 'proxy.antizapret.prostovpn.org:8443',
  '193.124.18.238': 'proxy.antizapret.prostovpn.org:8443',
  '188.130.137.66': 'proxy.antizapret.prostovpn.org:8443',
  '5.188.78.115': 'proxy.antizapret.prostovpn.org:8443',
  '185.112.102.133': 'proxy.antizapret.prostovpn.org:8443',
  '193.107.218.175': 'proxy.antizapret.prostovpn.org:8443',
  '176.119.157.170': 'proxy.antizapret.prostovpn.org:8443',
  '194.135.83.186': 'proxy.antizapret.prostovpn.org:8443',
  '185.204.1.203': 'proxy.antizapret.prostovpn.org:8443',
  '95.217.218.137': 'proxy.antizapret.prostovpn.org:8443',
  '159.69.208.243': 'proxy.antizapret.prostovpn.org:8443',
};

class IpToHostManager {
  #addresses = new Map(Object.entries(DEFAULT_PROXY_IPS));

  constructor() {
    this.initialized = false;
  }

  async init() {
    const saved = await storage.get(IP_STORAGE_KEY, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [ip, host] of Object.entries(saved)) {
        if (typeof host === 'string' && host.trim()) this.#remember(ip, host.trim());
      }
    }
    this.initialized = true;
  }

  get(ip) {
    return this.#addresses.get(ip) ?? null;
  }

  isProxyIp(ip) {
    return this.#addresses.has(ip);
  }

  #remember(ip, host) {
    if (typeof ip !== 'string') return;
    const key = ip.trim();
    if (!key || Object.hasOwn(Object.prototype, key)) return;
    if (this.#addresses.has(key)) {
      this.#addresses.set(key, host);
      return;
    }
    if (this.#addresses.size >= MAX_IP_MAP_SIZE) {
      // Built-ins are seeded first and never evicted. Drop one dynamic entry.
      for (const oldest of this.#addresses.keys()) {
        if (!Object.hasOwn(DEFAULT_PROXY_IPS, oldest)) {
          this.#addresses.delete(oldest);
          break;
        }
      }
    }
    this.#addresses.set(key, host);
  }

  addHost(host, ips = []) {
    if (!host) return;
    const cleanHost = String(host).trim();
    if (!cleanHost) return;

    // Safe IP extraction: handles bare IPs, host:port, [ipv6]:port and bare [ipv6]
    let bareIp = cleanHost;
    if (cleanHost.startsWith('[')) {
      bareIp = /^\[([^\]]+)](?::\d+)?$/.exec(cleanHost)?.[1] ?? cleanHost;
    } else {
      const colon = cleanHost.indexOf(':');
      if (colon !== -1 && cleanHost.indexOf(':', colon + 1) === -1) {
        bareIp = cleanHost.slice(0, colon);
      }
    }

    const isIPv4 = !cleanHost.startsWith('[') && /^(\d{1,3}\.){3}\d{1,3}$/.test(bareIp) &&
      bareIp.split('.').every((octet) => Number(octet) <= 255);
    let isIPv6 = false;
    if (bareIp.includes(':')) {
      try {
        isIPv6 = Boolean(new URL(`http://[${bareIp}]/`).hostname);
      } catch { /* not a valid IPv6 literal */ }
    }
    if (isIPv4 || isIPv6) {
      this.#remember(bareIp, cleanHost);
    }

    if (Array.isArray(ips)) {
      for (const ip of ips) this.#remember(ip, cleanHost);
    }
  }

  updateFromPac(pacData) {
    if (!pacData || typeof pacData !== 'string') return;
    const directive = /(?:HTTPS|PROXY|SOCKS5?)\s+([^\s;'"`]+)/gi;
    let match;
    while ((match = directive.exec(pacData)) !== null) {
      if (match[1] !== 'DIRECT') this.addHost(match[1]);
    }
  }

  reset() {
    this.#addresses = new Map(Object.entries(DEFAULT_PROXY_IPS));
    this.initialized = false;
  }

  async persistData() {
    await storage.set(IP_STORAGE_KEY, Object.fromEntries(this.#addresses));
  }

}

export const ipToHost = new IpToHostManager();
