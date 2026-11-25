import { appState } from './app-state.js';
import { pacSync } from './pac-sync.js';
import { clearProxyHealthCache } from './proxy-health-cache.js';
import { settingsBackup, prepareSettingsBackupImport, backupErrorMessage } from './settings-backup.js';

function backupFailure(code) {
  return { success: false, error: backupErrorMessage(code), errorCode: code };
}

export async function exportSettingsRpc(ensureCurrent) {
  let data;
  try { data = await settingsBackup.exportSettings(); }
  catch { return backupFailure('BACKUP_EXPORT_FAILED'); }
  ensureCurrent();
  return { success: true, data };
}

export async function importSettingsRpc(input, withSettingsReplacement) {
  // Validate before acquiring the barrier or touching even a cold worker's
  // initialization. The service consumes this private preflight handle once.
  let prepared;
  try { prepared = prepareSettingsBackupImport(input); }
  catch { return backupFailure('BACKUP_INVALID'); }
  return withSettingsReplacement(async () => {
    try {
      // An initializer predating the barrier must not publish after import.
      pacSync.cancelPendingSync();
      await appState.settlePendingInitialization();
      const data = await settingsBackup.importSettings(prepared);
      await clearProxyHealthCache().catch(() => {});
      return { success: true, data, settingsState: data.settingsState };
    } catch (error) {
      const code = ['BACKUP_INVALID', 'BACKUP_STORAGE_FAILED', 'BACKUP_ROLLBACK_FAILED'].includes(error?.code)
        ? error.code : 'BACKUP_IMPORT_FAILED';
      return backupFailure(code);
    }
  });
}
