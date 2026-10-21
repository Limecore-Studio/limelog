import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#82) — sign-out re-marks the onboarding flag as the
// signed-out account's, and the next sign-in asks the account. A returning
// user must not see the wizard, a new account on the same device must, and a
// question that could not be answered must change nothing.

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  row: null as { limelog_onboarded: boolean } | null,
  fail: false,
  upserts: [] as unknown[],
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (h.fail) throw new Error('Failed to fetch');
            return { data: h.row, error: null };
          },
        }),
      }),
      upsert: async (row: unknown) => {
        h.upserts.push(row);
        return { error: null };
      },
    }),
  },
}));

import { hydrateOnboardedFromCloud, isOnboarded, releaseOnboardingOnSignOut, setOnboarded, setTrainingGoal } from './onboarding';

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  h.user = { id: 'user-1' };
  h.row = null;
  h.fail = false;
  h.upserts = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('releaseOnboardingOnSignOut', () => {
  it('drops the goal, keeps the flag as done for a guest, and leaves the rest', () => {
    setOnboarded();
    setTrainingGoal('strength');
    localStorage.setItem('limecore_lang', 'fi');
    releaseOnboardingOnSignOut();
    expect(localStorage.getItem('limelog.trainingGoal')).toBeNull();
    expect(isOnboarded()).toBe(true); // no wizard at the next launch as a guest
    expect(localStorage.getItem('limelog.onboarded')).toBe('signed-out');
    expect(localStorage.getItem('limecore_lang')).toBe('fi');
  });

  it('leaves a device that never onboarded as it was', () => {
    releaseOnboardingOnSignOut();
    expect(localStorage.getItem('limelog.onboarded')).toBeNull();
  });
});

describe('hydrateOnboardedFromCloud after a sign-out', () => {
  beforeEach(() => {
    setOnboarded();
    releaseOnboardingOnSignOut();
  });

  it('a returning user: yes, and the flag is theirs again', async () => {
    h.row = { limelog_onboarded: true };
    expect(await hydrateOnboardedFromCloud()).toBe('yes');
    expect(localStorage.getItem('limelog.onboarded')).toBe('1');
  });

  it("a new account on the same device: no, and the previous account's mark goes", async () => {
    h.row = null;
    expect(await hydrateOnboardedFromCloud()).toBe('no');
    expect(isOnboarded()).toBe(false);
    expect(h.upserts).toEqual([]); // nothing claimed for an account that never onboarded
  });

  it('the query fails: unknown, and the flag is left alone', async () => {
    h.fail = true;
    expect(await hydrateOnboardedFromCloud()).toBe('unknown');
    expect(localStorage.getItem('limelog.onboarded')).toBe('signed-out');
  });

  it('getUser gives no user: unknown, not no', async () => {
    h.user = null;
    expect(await hydrateOnboardedFromCloud()).toBe('unknown');
    expect(isOnboarded()).toBe(true);
  });
});

describe('hydrateOnboardedFromCloud with this person\'s own flag', () => {
  it('done here (as a guest, or the cloud write failed): yes, and the account is told', async () => {
    setOnboarded();
    h.row = { limelog_onboarded: false };
    expect(await hydrateOnboardedFromCloud()).toBe('yes');
    expect(h.upserts).toHaveLength(1);
  });

  it('never onboarded anywhere: no', async () => {
    expect(await hydrateOnboardedFromCloud()).toBe('no');
  });

  it('done here, account unreachable: unknown, flag kept', async () => {
    setOnboarded();
    h.fail = true;
    expect(await hydrateOnboardedFromCloud()).toBe('unknown');
    expect(isOnboarded()).toBe(true);
  });
});
