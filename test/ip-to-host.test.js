import assert from 'node:assert/strict';
import { ipToHost } from '../src/common/core/ip-to-host.js';

describe('Diagnostic IP map', () => {
  it('only reports explicitly mapped addresses', () => {
    ipToHost.reset();
    try {
      assert.equal(ipToHost.get('constructor'), null);
      assert.equal(ipToHost.isProxyIp('toString'), false);
      ipToHost.addHost('proxy.test', ['192.0.2.1']);
      assert.equal(ipToHost.get('192.0.2.1'), 'proxy.test');
    } finally { ipToHost.reset(); }
  });

  it('learns literal proxy endpoints in source order across PAC and custom proxy text', () => {
    ipToHost.reset();
    try {
      ipToHost.updateFromPac(`function FindProxyForURL() {
        return 'proxy 192.0.2.1:80; HTTPS proxy.example.test:443; SoCkS5\t[2001:db8::1]:1080; DIRECT';
      }`);
      assert.equal(ipToHost.get('192.0.2.1'), '192.0.2.1:80');
      assert.equal(ipToHost.get('2001:db8::1'), '[2001:db8::1]:1080');
      assert.equal(ipToHost.get('proxy.example.test'), null);

      ipToHost.updateFromPac('SOCKS 2001:db8::2; HTTPS 192.0.2.1:443; PROXY 192.0.2.1:3128; PROXY 192.0.2.256:80');
      assert.equal(ipToHost.get('2001:db8::2'), '2001:db8::2');
      assert.equal(ipToHost.get('192.0.2.1'), '192.0.2.1:3128');
      assert.equal(ipToHost.get('192.0.2.256'), null);
    } finally { ipToHost.reset(); }
  });
});
