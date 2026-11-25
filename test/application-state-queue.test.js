import assert from 'node:assert/strict';
import { applicationState } from '../src/common/core/application-state.js';
import { storage } from '../src/common/core/storage.js';

describe('Application state queue', () => {
  it('serializes saves submitted on either side of a reset', async () => {
    const original = { get: storage.get, set: storage.set };
    const writes = [];
    let saved = {};
    let release;
    let started;
    const firstStarted = new Promise(resolve => { started = resolve; });
    const firstPending = new Promise(resolve => { release = resolve; });
    try {
      await applicationState.reset();
      storage.get = async () => saved;
      storage.set = async (_, state) => {
        writes.push(state.appliedRevision);
        if (state.appliedRevision === 1) { started(); await firstPending; }
        saved = state;
      };
      const first = applicationState.save({ appliedRevision: 1 });
      await firstStarted;
      const reset = applicationState.reset();
      const second = applicationState.save({ appliedRevision: 2 });
      release();
      await reset;
      const third = applicationState.save({ appliedRevision: 3 });
      await Promise.all([first, second, third]);
      assert.deepEqual(writes, [1, 2, 3]);
      assert.equal((await applicationState.get(3)).pending, false);
    } finally {
      release?.();
      await applicationState.reset();
      Object.assign(storage, original);
    }
  });
});
