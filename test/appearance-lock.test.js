import { expect } from 'chai';

function locksFixture() {
  let tail = Promise.resolve();
  return { request(name, operation) { const next = tail.then(operation); tail = next.catch(() => {}); return next; } };
}

describe('Appearance origin-wide write/reset lock', () => {
  it('serializes a reset after the in-flight write and preserves the next selection', async () => {
    const { withAppearanceWriteLock } = await import('../src/common/core/appearance-lock.js');
    const locks = locksFixture(), events = [];
    let releaseWrite, value;
    const writing = withAppearanceWriteLock(async () => {
      events.push('write');
      await new Promise(resolve => { releaseWrite = resolve; });
      value = 'old';
    }, locks);
    await new Promise(resolve => setTimeout(resolve, 0));
    const reset = withAppearanceWriteLock(() => { events.push('reset'); value = undefined; }, locks);
    const next = withAppearanceWriteLock(() => { events.push('next'); value = 'new'; }, locks);
    expect(events).deep.equal(['write']);
    releaseWrite(); await Promise.all([writing, reset, next]);
    expect(events).deep.equal(['write', 'reset', 'next']);
    expect(value).equal('new');
  });
  it('releases the lock after a failed operation', async () => {
    const { withAppearanceWriteLock } = await import('../src/common/core/appearance-lock.js');
    const locks = locksFixture();
    try { await withAppearanceWriteLock(() => { throw Error('failed'); }, locks); } catch { /* Expected. */ }
    expect(await withAppearanceWriteLock(() => 'saved', locks)).equal('saved');
  });
});
