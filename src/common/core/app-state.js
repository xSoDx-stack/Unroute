'use strict';

import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import { ipToHost } from './ip-to-host.js';
import { errorHandlers } from './error-handlers.js';
import { logger } from './logger.js';
import { storage } from './storage.js';

/**
 * Global AppState Manager for Manifest V3 Service Worker
 * Guarantees unified, idempotent initialization for every service worker instance
 */
class AppStateManager {
  constructor() {
    this._requestInitPromise = null;
    this._initPromise = null;
    this._localInitPromise = null;
    this.isRequestStateInitialized = false;
    this.isInitialized = false;
  }

  /**
   * Restores only the state needed by high-frequency request/auth handlers.
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
          await storage.restrictLocalAccess();

          // pacKitchen.getPacMods restores persistent proxy credentials too.
          const results = await Promise.allSettled([
            logger.init(),
            ipToHost.init(),
            errorHandlers.init(),
            pacKitchen.getPacMods(),
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
    await Promise.allSettled([this._requestInitPromise, this._localInitPromise, this._initPromise]);
  }

  /** Reset initialization state (useful for tests or full reloads). */
  reset() {
    this._requestInitPromise = null;
    this._initPromise = null;
    this._localInitPromise = null;
    this.isRequestStateInitialized = false;
    this.isInitialized = false;
  }
}

export const appState = new AppStateManager();
