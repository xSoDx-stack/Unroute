import { expect } from 'chai';
import { withProxySettingsLock, whenProxySettingsIdle } from '../src/common/core/proxy-settings-lock.js';

describe('Proxy mutation completion', () => {
  it('defers reconciliation until a temporary configuration has been restored', async () => {
    let release;
    let started;
    let restored = false;
    let reconciled = false;
    const ready = new Promise(resolve => { started = resolve; });
    const probe = withProxySettingsLock(async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      restored = true;
    });
    await ready;
    const reconcile = whenProxySettingsIdle().then(() => { expect(restored).to.equal(true); reconciled = true; });
    await Promise.resolve();
    expect(reconciled).to.equal(false);
    release();
    await Promise.all([probe, reconcile]);
    expect(reconciled).to.equal(true);
    await withProxySettingsLock(() => { throw new Error('Temporary operation failed'); }).catch(() => {});
    await whenProxySettingsIdle();
  });
});
