'use strict';

import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import { ipToHost } from './ip-to-host.js';
import { errorHandlers } from './error-handlers.js';
import { logger } from './logger.js';
import { initProxyAuth } from './proxy-auth.js';
import { storage } from './storage.js';

/**
 * Global AppState Manager for Manifest V3 Service Worker
 * Guarantees unified, idempotent initialization for every service worker instance
 */
class AppStateManager {
  constructor() {
    this.reset();
  }

  ensureStorageAccessRestricted() {
    if (!this._storageAccessPromise) {
      this._storageAccessPromise = storage.restrictLocalAccess().catch(error => {
        this._storageAccessPromise = null;
        throw error;
      });
    }
    return this._storageAccessPromise;
  }

  ensureProxyAuthInitialized() {
    if (!this._authInitPromise) {
      this._authInitPromise = (async () => {
        await this.ensureStorageAccessRestricted();
        // Reuse the canonical read/migration, but don't compile routing rules
        // or calculate UI statistics just to answer a proxy challenge.
        await initProxyAuth(() => pacKitchen.getRawPacMods());
      })().catch(error => {
        this._authInitPromise = null;
        throw error;
      });
    }
    return this._authInitPromise;
  }

  ensureLoggerInitialized() {
    if (!this._loggerInitPromise) {
      this._loggerInitPromise = logger.init().catch(error => {
        this._loggerInitPromise = null;
        throw error;
      });
    }
    return this._loggerInitPromise;
  }

  ensureErrorHandlersInitialized() {
    errorHandlers.setDiagnosticContextProvider(() => ({
      mods: pacKitchen.getCachedMods(),
      pacProviderKey: pacSync.isInitialized ? pacSync.currentPacProviderKey : '',
      customPacUrl: pacSync.isInitialized ? pacSync.customPacUrl : '',
    }));
    if (!this._errorHandlersInitPromise) {
      this._errorHandlersInitPromise = errorHandlers.init().catch(error => {
        this._errorHandlersInitPromise = null;
        throw error;
      });
    }
    return this._errorHandlersInitPromise;
  }

  ensureRoutingStateInitialized() {
    if (!this._routingInitPromise) this._routingInitPromise = (async () => {
      await this.ensureStorageAccessRestricted();
      const results = await Promise.allSettled([ipToHost.init(), pacKitchen.getPacMods()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })().catch(error => {
      this._routingInitPromise = null;
      throw error;
    });
    return this._routingInitPromise;
  }

  /**
   * Restores shared routing state and the diagnostics needed by RPCs.
   * Keeping PAC restoration out of this path prevents a large PAC script from
   * being parsed every time the browser wakes the MV3 service worker.
   * @returns {Promise<void>}
   */
  async ensureRequestStateInitialized() {
    if (this.isRequestStateInitialized) {
      return;
    }
    if (!this._requestInitPromise) {
      this._requestInitPromise = (async () => {
        try {
          await this.ensureStorageAccessRestricted();

          // pacKitchen.getPacMods restores persistent proxy credentials too.
          const results = await Promise.allSettled([
            this.ensureLoggerInitialized(),
            this.ensureRoutingStateInitialized(),
            this.ensureErrorHandlersInitialized(),
          ]);
          const failedResult = results.find((result) => result.status === 'rejected');
          if (failedResult) {
            throw failedResult.reason;
          }

          this.isRequestStateInitialized = true;
        } catch (err) {
          console.error('[AppState] Request state initialization error:', err);
          this.isRequestStateInitialized = false;
          this._requestInitPromise = null;
          throw err;
        }
      })();
    }
    return this._requestInitPromise;
  }

  /**
   * Idempotent initialization promise for the current Service Worker lifecycle instance.
   * Guarantees all subsystems (storage, credentials, pac-sync, logs, error handlers)
   * are fully restored into memory before handling events or messages.
   * @returns {Promise<void>}
   */
  async ensureInitialized() {
    if (this.isInitialized) {
      return;
    }
    if (!this._initPromise) {
      this._initPromise = (async () => {
        try {
          await this.ensureRequestStateInitialized();

          // Initialize PAC sync manager with restored storage settings.
          await pacSync.init();

          this.isInitialized = true;
        } catch (err) {
          console.error('[AppState] Service Worker initialization error:', err);
          this.isInitialized = false;
          // A later event may retry after a transient storage/network failure.
          this._initPromise = null;
          throw err;
        }
      })();
    }
    return this._initPromise;
  }

  ensureLocalStateInitialized() {
    if (!this._localInitPromise) this._localInitPromise = (async () => {
      await this.ensureRequestStateInitialized();
      await pacSync.loadLocalState();
    })().catch(error => {
      this._localInitPromise = null;
      throw error;
    });
    return this._localInitPromise;
  }

  async settlePendingInitialization() {
    // Old initializers must settle before reset clears their persistent state.
    await Promise.allSettled([
      this._storageAccessPromise, this._authInitPromise, this._loggerInitPromise,
      this._errorHandlersInitPromise, this._routingInitPromise, this._requestInitPromise, this._localInitPromise, this._initPromise,
    ]);
  }

  /** Reset initialization state (useful for tests or full reloads). */
  reset() {
    this._routingInitPromise = null;
    this._storageAccessPromise = null;
    this._authInitPromise = null;
    this._loggerInitPromise = null;
    this._errorHandlersInitPromise = null;
    this._requestInitPromise = null;
    this._initPromise = null;
    this._localInitPromise = null;
    this.isRequestStateInitialized = false;
    this.isInitialized = false;
  }
}

export const appState = new AppStateManager();
