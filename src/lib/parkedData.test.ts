import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#90) — the slots themselves: at most five accounts, the
// oldest dropped first, and an account deletion takes its own slot with it.

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  prefs: new Map<string, string>(),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: h.prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void h.prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void h.prefs.delete(key),
  },
}));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: h.session } }),
      signOut: async () => ({ error: null }),
    },
    functions: { invoke: async () => ({ error: null }) },
  },
}));

const { parkAccountData, parkedFor, restoreParked, MAX_SLOTS, PARKED_KEY } = await import('./parkedData');
const { deleteAccount } = await import('./dataRights');
const owner = await import('./accountOwner');

/** `refuse` makes setItem throw for that key, as a full store does. */
function storage(refuse?: string) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (k === refuse) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const pr = (id: string) => ({
  id, exerciseId: 'squat', exerciseName: 'Squat', weightKg: 100, reps: 1, oneRepMaxKg: 100, sessionId: 's', date: '2026-10-01', createdAt: '2026-10-01T10:00:00Z',
});

/** `userId` trains, then its data is set aside at `at`. */
function parkAt(userId: string, at: string) {
  vi.setSystemTime(new Date(at));
  localStorage.setItem('wt_exercise_prs', JSON.stringify([pr(`${userId}-1`)]));
  expect(parkAccountData(userId)).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  h.session = null;
  h.prefs.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const profile = (name: string, restrictions: { id: string }[] = []) => ({
  id: `p-${name}`, name, unitPreference: 'kg', activeRestrictions: restrictions.map((r) => ({ ...r, label: r.id, restrictedPatterns: [], restrictedExerciseIds: [], severity: 'avoid', active: true, createdAt: '' })),
  deloadThresholds: { stallCountTrigger: 2, avgFatigueTrigger: 7.5, fatigueLookbackSessions: 5 }, createdAt: '',
});

describe('parked slots', () => {
  it(`are kept for at most ${MAX_SLOTS} accounts, the oldest dropped first`, () => {
    for (let i = 1; i <= 6; i++) parkAt(`user-${i}`, `2026-10-0${i}T10:00:00Z`);
    expect(parkedFor('user-1')).toBeNull();
    for (let i = 2; i <= 6; i++) expect(parkedFor(`user-${i}`), `user-${i}`).not.toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('dropping the oldest, user-1'));
    expect(Object.keys(JSON.parse(localStorage.getItem(PARKED_KEY)!))).toHaveLength(MAX_SLOTS);
  });

  it('nothing to set aside: no slot', () => {
    expect(parkAccountData('user-a')).toBe(true);
    expect(parkedFor('user-a')).toBeNull();
  });

  it('a slot that could not be put back is joined, not replaced, the next time', () => {
    parkAt('user-a', '2026-10-01T10:00:00Z');
    localStorage.setItem('wt_exercise_prs', JSON.stringify([pr('user-a-2')]));
    parkAccountData('user-a');
    expect(parkedFor('user-a')!.prs.map((p) => p.id)).toEqual(['user-a-1', 'user-a-2']);
  });

  it("a slot still there keeps the account's own profile over one made since (a guest's)", () => {
    localStorage.setItem('wt_profile', JSON.stringify(profile('Alex', [{ id: 'knee' }])));
    parkAccountData('user-a');
    localStorage.setItem('wt_profile', JSON.stringify(profile('Athlete', [{ id: 'wrist' }])));
    parkAccountData('user-a');
    const kept = parkedFor('user-a')!.profile!;
    expect(kept.name).toBe('Alex');
    expect(kept.activeRestrictions.map((r) => r.id)).toEqual(['knee', 'wrist']);
  });

  it('a slot that cannot be written leaves the records and profile on the device', () => {
    vi.stubGlobal('localStorage', storage(PARKED_KEY));
    localStorage.setItem('wt_exercise_prs', JSON.stringify([pr('a1')]));
    localStorage.setItem('wt_profile', JSON.stringify(profile('Alex')));
    expect(parkAccountData('user-a')).toBe(false); // the clear reports it; a switch waits
    expect(localStorage.getItem('wt_exercise_prs')).not.toBeNull();
    expect(localStorage.getItem('wt_profile')).not.toBeNull();
  });

  it('another account gets nothing back', () => {
    parkAt('user-a', '2026-10-01T10:00:00Z');
    expect(restoreParked('user-b')).toBeNull();
    expect(localStorage.getItem('wt_exercise_prs')).toBeNull();
  });

  it('deleting the account drops its slot, and only its slot', async () => {
    parkAt('user-a', '2026-10-01T10:00:00Z');
    parkAt('user-b', '2026-10-02T10:00:00Z');
    h.session = { user: { id: 'user-a' } };
    // A clearLocal that leaves the slots, so the drop is deleteAccount's own.
    await deleteAccount({ clearLocal: async () => {} });
    expect(parkedFor('user-a')).toBeNull();
    expect(parkedFor('user-b')).not.toBeNull();
  });

  it('deleting the account has cleared the Preferences mirror by the time it resolves (the page reloads next)', async () => {
    vi.useRealTimers();
    owner.adoptLocalData('user-a', 'a@example.com');
    h.session = { user: { id: 'user-a' } };
    await deleteAccount({ clearLocal: async () => {} });
    expect(h.prefs.has(owner.OWNER_KEY)).toBe(false);
    expect(h.prefs.has(owner.OWNER_EMAIL_KEY)).toBe(false);
  });
});
