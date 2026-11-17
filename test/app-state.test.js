'use strict';

import { expect } from 'chai';
import { appState } from '../src/common/core/app-state.js';
import { logger } from '../src/common/core/logger.js';
import { ipToHost } from '../src/common/core/ip-to-host.js';
import { errorHandlers } from '../src/common/core/error-handlers.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { storage } from '../src/common/core/storage.js';

describe('AppState initialization', () => {
  it('keeps request initialization independent from heavy PAC restoration', async () => {
    const originals = {
      loggerInit: logger.init,
      ipToHostInit: ipToHost.init,
      errorHandlersInit: errorHandlers.init,
      getPacMods: pacKitchen.getPacMods,
      pacSyncInit: pacSync.init,
      restrictLocalAccess: storage.restrictLocalAccess,
    };
    const calls = {
      logger: 0,
      ipToHost: 0,
      errorHandlers: 0,
      pacMods: 0,
      pacSync: 0,
      restrict: 0,
    };

    appState.reset();
    logger.init = async () => { calls.logger++; };
    ipToHost.init = async () => { calls.ipToHost++; };
    errorHandlers.init = async () => { calls.errorHandlers++; };
    pacKitchen.getPacMods = async () => { calls.pacMods++; return {}; };
    pacSync.init = async () => { calls.pacSync++; };
    storage.restrictLocalAccess = async () => { calls.restrict++; };

    try {
      await Promise.all([
        appState.ensureRequestStateInitialized(),
        appState.ensureRequestStateInitialized(),
      ]);

      expect(appState.isRequestStateInitialized).to.equal(true);
      expect(appState.isInitialized).to.equal(false);
      expect(calls).to.deep.equal({
        logger: 1,
        ipToHost: 1,
        errorHandlers: 1,
        pacMods: 1,
        pacSync: 0,
        restrict: 1,
      });

      await Promise.all([
        appState.ensureInitialized(),
        appState.ensureInitialized(),
      ]);

      expect(appState.isInitialized).to.equal(true);
      expect(calls.pacSync).to.equal(1);
      expect(calls.logger).to.equal(1);
      expect(calls.pacMods).to.equal(1);
    } finally {
      logger.init = originals.loggerInit;
      ipToHost.init = originals.ipToHostInit;
      errorHandlers.init = originals.errorHandlersInit;
      pacKitchen.getPacMods = originals.getPacMods;
      pacSync.init = originals.pacSyncInit;
      storage.restrictLocalAccess = originals.restrictLocalAccess;
      appState.reset();
    }
  });

  it('deduplicates an in-flight initialization and permits retry after failure', async () => {
    const originals = {
      loggerInit: logger.init,
      ipToHostInit: ipToHost.init,
      errorHandlersInit: errorHandlers.init,
      getPacMods: pacKitchen.getPacMods,
      pacSyncInit: pacSync.init,
      restrictLocalAccess: storage.restrictLocalAccess,
      consoleError: console.error,
    };
    let loggerInitCalls = 0;
    let releaseSlowInitializer;
    const slowInitializer = new Promise((resolve) => {
      releaseSlowInitializer = resolve;
    });

    appState.reset();
    logger.init = async () => {
      loggerInitCalls += 1;
      throw new Error('initialization failed');
    };
    ipToHost.init = () => slowInitializer;
    errorHandlers.init = async () => {};
    pacKitchen.getPacMods = async () => ({});
    pacSync.init = async () => {};
    storage.restrictLocalAccess = async () => {};
    console.error = () => {};

    try {
      const firstAttempt = appState.ensureInitialized().catch((err) => err);
      const sameAttempt = appState.ensureInitialized().catch((err) => err);
      await Promise.resolve();
      await Promise.resolve();
      expect(loggerInitCalls).to.equal(1);

      releaseSlowInitializer();
      const [firstError, secondError] = await Promise.all([firstAttempt, sameAttempt]);
      expect(firstError).to.be.an('error').with.property('message', 'initialization failed');
      expect(secondError).to.equal(firstError);
      expect(appState.isInitialized).to.equal(false);

      logger.init = async () => {
        loggerInitCalls += 1;
      };
      ipToHost.init = async () => {};
      await appState.ensureInitialized();

      expect(loggerInitCalls).to.equal(2);
      expect(appState.isInitialized).to.equal(true);
    } finally {
      releaseSlowInitializer();
      logger.init = originals.loggerInit;
      ipToHost.init = originals.ipToHostInit;
      errorHandlers.init = originals.errorHandlersInit;
      pacKitchen.getPacMods = originals.getPacMods;
      pacSync.init = originals.pacSyncInit;
      storage.restrictLocalAccess = originals.restrictLocalAccess;
      console.error = originals.consoleError;
      appState.reset();
    }
  });
});
