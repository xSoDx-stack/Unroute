'use strict';

import { t } from './i18n.js';

import { pacKitchen } from './pac-kitchen.js';
import { pacSync } from './pac-sync.js';
import { applicationState } from './application-state.js';
import { describeHistory, undoRuleChange, clearRuleHistory } from './settings-schema.js';

let applying = Promise.resolve();
let generation = 0;
let resetting = false;
let activeApplications = 0;
export const settingsCoordinator = {
  async state() {
    const raw = await pacKitchen.getRawPacMods();
    return { ...await applicationState.get(raw._revision || 0), applying: activeApplications > 0 };
  },
  apply() {
    if (resetting) return Promise.reject(new Error(t("msg_settings_are_being_reset_3089ff9b", "Выполняется сброс настроек")));
    const expectedGeneration = generation;
    const task = async () => {
      if (expectedGeneration !== generation) return this.state();
      await pacSync.loadLocalState();
      if (expectedGeneration !== generation) return this.state();
      const raw = await pacKitchen.getRawPacMods();
      if (expectedGeneration !== generation) return this.state();
      try {
        await pacSync.reapplyCurrentPac();
        if (pacSync.currentPacProviderKey === 'none') await applicationState.applied(raw._revision || 0);
        const state = await this.state();
        if (state.pending) throw pacSync.lastError || new Error(t("msg_applying_settings_is_waiting_for_another_atte_286026df", "Применение настроек ожидает повторной попытки"));
        return state;
      } catch (error) {
        if (expectedGeneration !== generation) return this.state();
        await applicationState.save({ error: error.message || String(error) });
        return this.state();
      }
    };
    activeApplications++;
    const result = applying.then(task, task).finally(() => { activeApplications--; })
      .then(state => ({ ...state, applying: activeApplications > 0 }));
    applying = result.catch(() => {});
    return result;
  },
  async history() { return describeHistory(await pacKitchen.getRawPacMods()); },
  async drainForReset() {
    resetting = true;
    generation++;
    pacSync.cancelPendingSync();
    await applying;
  },
  finishReset() { resetting = false; },
  async clearHistory() {
    await pacKitchen.updatePacMods(clearRuleHistory, { metadataOnly: true, preferencesOnly: true });
  },
  async undo(id = null) {
    let result;
    await pacKitchen.updatePacMods(current => {
      result = undoRuleChange(current, id);
      return result.settings;
    }, { source: 'undo', copyOnWrite: true });
    await this.apply();
    return { restored: result.restored, skipped: result.skipped };
  },
};
