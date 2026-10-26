import { expect } from 'chai';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  RKN_BLOCKLIST_URL,
  RKN_PREFILL_FRAGMENT_KEY,
  buildRknBlocklistUrl,
  normalizeRknLookupDomain,
} from '../src/extension-common/core/rkn-blocklist.js';

function runPrefillScript(fragmentValue) {
  const scriptUrl = new URL(
    '../src/extension-common/content-scripts/rkn-search-prefill.js',
    import.meta.url
  );
  const input = {
    dispatchedEvents: [],
    focused: false,
    value: '',
    dispatchEvent(event) {
      this.dispatchedEvents.push(event.type);
    },
    focus() {
      this.focused = true;
    },
  };
  let replacedUrl = null;
  const context = {
    URL,
    URLSearchParams,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      querySelector: () => input,
    },
    window: {
      history: {
        replaceState: (_state, _title, url) => {
          replacedUrl = url;
        },
      },
      location: {
        hash: `#${RKN_PREFILL_FRAGMENT_KEY}=${encodeURIComponent(fragmentValue)}`,
        pathname: '/',
        search: '',
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(scriptUrl, 'utf8'), context);
  return { input, replacedUrl };
}

describe('RKN blocklist lookup links', () => {
  it('keeps only the registrable domain from a complete page URL', () => {
    const result = normalizeRknLookupDomain(
      'https://user:secret@www.youtube.com/watch?v=123#private-fragment'
    );

    expect(result).to.equal('youtube.com');
  });

  it('handles subdomains, multi-level zones and private suffixes', () => {
    expect(normalizeRknLookupDomain('https://cdn.sub.example.com/path'))
      .to.equal('example.com');
    expect(normalizeRknLookupDomain('https://news.bbc.co.uk/article'))
      .to.equal('bbc.co.uk');
    expect(normalizeRknLookupDomain('https://docs.user.github.io/guide'))
      .to.equal('user.github.io');
  });

  it('normalizes IDNs and preserves IP lookup targets', () => {
    expect(normalizeRknLookupDomain('https://пример.рф/страница'))
      .to.equal('xn--e1afmkfd.xn--p1ai');
    expect(normalizeRknLookupDomain('http://192.168.1.1:8080/path'))
      .to.equal('192.168.1.1');
    expect(normalizeRknLookupDomain('http://[::1]:8080/path'))
      .to.equal('[::1]');
  });

  it('rejects browser and extension URLs', () => {
    expect(normalizeRknLookupDomain('chrome://extensions/')).to.equal('');
    expect(normalizeRknLookupDomain('chrome-extension://example/options.html')).to.equal('');
  });

  it('passes only the lookup domain in a fragment that is not sent to the server', () => {
    const target = 'https://пример.рф/page?q=1';
    const result = new URL(buildRknBlocklistUrl(target));
    const params = new URLSearchParams(result.hash.slice(1));

    expect(result.origin + result.pathname).to.equal(RKN_BLOCKLIST_URL);
    expect(params.get(RKN_PREFILL_FRAGMENT_KEY))
      .to.equal('xn--e1afmkfd.xn--p1ai');
  });

  it('prefills the RKN form with a domain and rejects a tampered full URL', () => {
    const valid = runPrefillScript('youtube.com');
    expect(valid.input.value).to.equal('youtube.com');
    expect(valid.input.dispatchedEvents).to.deep.equal(['input', 'change']);
    expect(valid.input.focused).to.equal(true);
    expect(valid.replacedUrl).to.equal('/');

    const tampered = runPrefillScript('https://www.youtube.com/watch');
    expect(tampered.input.value).to.equal('');
    expect(tampered.input.dispatchedEvents).to.deep.equal([]);
    expect(tampered.replacedUrl).to.equal(null);
  });

  it('opens the service without prefill for an invalid address', () => {
    expect(buildRknBlocklistUrl('about:blank')).to.equal(RKN_BLOCKLIST_URL);
  });
});
