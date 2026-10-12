import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.18.1 (LimeLog#75) — "Erase account" clears local storage by prefix
// (`wt_`, `limelog-`), and four keys outside those prefixes survived it.

vi.mock('./supabase', () => ({ isNexusConfigured: false, supabase: {} }));

const { wipeAllLocalData } = await import('./dataRights');

/** localStorage whose own enumerable keys are the stored items, as in a
 *  browser: wipeAllLocalData lists them with Object.keys. */
function storage(items: Record<string, string>) {
  const ls = { ...items };
  Object.defineProperty(ls, 'removeItem', { value: (k: string) => void delete (ls as Record<string, string>)[k] });
  Object.defineProperty(ls, 'getItem', { value: (k: string) => (ls as Record<string, string>)[k] ?? null });
  return ls;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage({
    'limelog.trainingGoal': 'strength',
    'limelog.referralAsked': '1',
    referral_source: '{"source":"reddit"}',
    limecore_origin: '{"app":"limelog"}',
    wt_session_logs: '[]',
    'limelog-outbox': '[]',
    limecore_lang: 'fi',
  }));
});

describe('wipeAllLocalData', () => {
  it('removes the keys the prefixes miss, as well as the prefixed ones', () => {
    wipeAllLocalData();
    expect(Object.keys(localStorage)).toEqual(['limecore_lang']);
  });
});
