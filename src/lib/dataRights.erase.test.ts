import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#77 item 3) — erasing the account removes every LimeLog key,
// the `limelog.` flags included, and leaves the suite's device settings. Its
// own file: the training PR (#79) adds dataRights.test.ts for the keys it
// names one by one.

vi.mock('./supabase', () => ({ isNexusConfigured: false, supabase: {} }));

import { wipeAllLocalData } from './dataRights';

// wipeAllLocalData lists keys with Object.keys(localStorage), which in a
// browser returns the stored keys. Stored entries are own enumerable
// properties here and the methods are not, so the stand-in behaves the same.
function fakeLocalStorage(): Storage {
  const store = {} as Record<string, string>;
  const methods = {
    getItem: (k: string) => (Object.keys(store).includes(k) ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(store, name, { value, enumerable: false });
  }
  Object.defineProperty(store, 'length', { get: () => Object.keys(store).length, enumerable: false });
  return store as unknown as Storage;
}

describe('wipeAllLocalData', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the account flags along with the data', () => {
    const doomed = [
      'wt_session_logs',
      'wt_profile',
      'limelog-body-metrics',
      'limelog-progress-photos',
      'limelog.onboarded',
      'limelog.guestMode',
      'limelog.lastAppOpen',
      'limelog.trainingGoal',
      'limelog.referralAsked',
    ];
    for (const k of doomed) localStorage.setItem(k, '1');
    localStorage.setItem('limecore_lang', 'fi');
    localStorage.setItem('limelog-fdroid-check', 'off');

    wipeAllLocalData();

    for (const k of doomed) expect(localStorage.getItem(k), k).toBeNull();
    expect(localStorage.getItem('limecore_lang')).toBe('fi');
    // A device setting under the limelog- prefix survives.
    expect(localStorage.getItem('limelog-fdroid-check')).toBe('off');
  });
});
