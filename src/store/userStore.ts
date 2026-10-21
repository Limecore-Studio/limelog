import { create } from 'zustand';
import { storage } from '@/utils/storage';
import { generateId } from '@/utils/helpers';
import type { UserProfile, InjuryRestriction } from '@/types/user';

// v1.18.1 (LimeLog#90) — a fresh default, for the store after the account
// clear sets the profile aside (lib/parkedData.ts).
export function defaultProfile(): UserProfile {
  return {
    ...DEFAULT_PROFILE,
    id: generateId(),
    deloadThresholds: { ...DEFAULT_PROFILE.deloadThresholds },
    activeRestrictions: [],
    createdAt: new Date().toISOString(),
  };
}

const DEFAULT_PROFILE: UserProfile = {
  id: generateId(),
  name: 'Athlete',
  unitPreference: 'kg',
  aiEnabled: false,
  activeRestrictions: [],
  deloadThresholds: {
    stallCountTrigger: 2,
    avgFatigueTrigger: 7.5,
    fatigueLookbackSessions: 5,
  },
  createdAt: new Date().toISOString(),
};

interface UserStore {
  profile: UserProfile;
  setName: (name: string) => void;
  setUnit: (unit: 'kg' | 'lb') => void;
  setAiEnabled: (on: boolean) => void;
  addRestriction: (r: Omit<InjuryRestriction, 'id' | 'createdAt'>) => void;
  resolveRestriction: (id: string) => void;
  removeRestriction: (id: string) => void;
  updateDeloadThresholds: (t: Partial<UserProfile['deloadThresholds']>) => void;
}

export const useUserStore = create<UserStore>((set, get) => ({
  profile: storage.getProfile() ?? DEFAULT_PROFILE,

  setName: (name) => {
    const profile = { ...get().profile, name };
    storage.setProfile(profile);
    set({ profile });
  },

  setUnit: (unit) => {
    const profile = { ...get().profile, unitPreference: unit };
    storage.setProfile(profile);
    set({ profile });
  },

  setAiEnabled: (on) => {
    const profile = { ...get().profile, aiEnabled: on };
    storage.setProfile(profile);
    set({ profile });
  },

  addRestriction: (r) => {
    const restriction: InjuryRestriction = {
      ...r,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    const profile = {
      ...get().profile,
      activeRestrictions: [...get().profile.activeRestrictions, restriction],
    };
    storage.setProfile(profile);
    set({ profile });
  },

  resolveRestriction: (id) => {
    const profile = {
      ...get().profile,
      activeRestrictions: get().profile.activeRestrictions.map((r) =>
        r.id === id ? { ...r, active: false, resolvedAt: new Date().toISOString() } : r
      ),
    };
    storage.setProfile(profile);
    set({ profile });
  },

  removeRestriction: (id) => {
    const profile = {
      ...get().profile,
      activeRestrictions: get().profile.activeRestrictions.filter((r) => r.id !== id),
    };
    storage.setProfile(profile);
    set({ profile });
  },

  updateDeloadThresholds: (t) => {
    const profile = {
      ...get().profile,
      deloadThresholds: { ...get().profile.deloadThresholds, ...t },
    };
    storage.setProfile(profile);
    set({ profile });
  },
}));
