'use strict';

import { storage } from './storage.js';

const KEY = 'settings-application';
let state = { appliedRevision: 0, error: '', appliedAt: 0 };
let ready = null;
let queue = Promise.resolve();

async function init() {
  if (!ready) ready = storage.get(KEY, state).then(saved => { state = { ...state, ...saved }; }).catch(error => {
    ready = null;
    throw error;
  });
  await ready;
}

export const applicationState = {
  async get(desiredRevision = 0) {
    await init();
    return { ...state, desiredRevision, pending: state.appliedRevision !== desiredRevision };
  },
  save(patch) {
    const task = async () => {
      await init();
      const next = { ...state, ...patch };
      await storage.set(KEY, next);
      state = next;
    };
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  },
  applied(revision) { return this.save({ appliedRevision: revision || 0, error: '', appliedAt: Date.now() }); },
  async reset() {
    await queue;
    if (ready) await ready.catch(() => {});
    state = { appliedRevision: 0, error: '', appliedAt: 0 };
    ready = null;
    queue = Promise.resolve();
  },
};
