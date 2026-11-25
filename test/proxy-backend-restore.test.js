import assert from 'node:assert/strict';
import { proxyBackend } from '../src/common/core/proxy-backend.js';

describe('Chromium proxy ownership restoration', () => {
  it('clears temporary settings rather than taking ownership of a system proxy', async () => {
    const calls = [];
    const original = globalThis.chrome;
    globalThis.chrome = { runtime: {}, proxy: { settings: {
      set: (details, done) => { calls.push(['set', details]); done(); },
      clear: (details, done) => { calls.push(['clear', details]); done(); },
    } } };
    try {
      await proxyBackend.restore({ levelOfControl: 'controllable_by_this_extension', value: { mode: 'system' } });
      assert.deepEqual(calls, [['clear', { scope: 'regular' }]]);
    } finally {
      globalThis.chrome = original;
    }
  });
});
