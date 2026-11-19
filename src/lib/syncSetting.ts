// The "Sync with Nexus" switch, read where a write is queued. Moved out of
// nexusStore (v1.22, limecore#95) so the body-metrics store can apply the same
// gate as workouts without importing the auth store.
import { isNexusConfigured } from './supabase';

export const SYNC_ENABLED_KEY = 'wt_nexus_sync_enabled';

export function readSyncEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SYNC_ENABLED_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function writeSyncEnabled(v: boolean): void {
  localStorage.setItem(SYNC_ENABLED_KEY, String(v));
}

/** Whether a change may be queued for upload: configured and switched on. */
export function syncAllowed(): boolean {
  return isNexusConfigured && readSyncEnabled();
}
