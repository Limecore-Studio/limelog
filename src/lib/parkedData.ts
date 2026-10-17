// v1.18.1 (LimeLog#90) — the personal records and the profile, set aside per
// account when that account's local data is cleared, and put back when it
// takes the device up again.
//
// The clear (accountWipe.ts) left `wt_exercise_prs` and `wt_profile` on the
// device, so the next person saw the previous account's records (and PR
// detection compared their sets against them) and its profile: name, units,
// the AI setting, injury restrictions. Removing them outright is not an
// option. The records are push-only (nothing pulls them back) and the profile
// exists only on the device, so the same person signing out and back in would
// lose both for good.
//
// So the clear moves them into a slot for that account, under one key,
// `limelog.parked` → { [userId]: { prs, profile, parkedAt } }, and empties the
// live keys and the stores. The next account to take the device up gets its
// own slot back, if it has one (accountWipe.restoreAccountData, called by
// accountOwner.ts on a change of owner, and for the same owner while a slot
// of its is still there: one whose restore failed, or a launch that found
// the owner in the Preferences mirror after a sign-out):
//   - records: the parked rows and any on the device (a guest's, taken up as
//     before) are joined by id. They are append-only rows and the current
//     record is the best of them (prDetection.currentPR), so nothing is lost;
//   - profile: the parked one, the account's own settings, wins over one made
//     on the device meanwhile (a guest's, which started from the defaults).
//     Restrictions added meanwhile are kept, added after the account's own:
//     they are about someone's body, so they are not dropped.
// A slot is kept for at most MAX_SLOTS accounts (the oldest goes first). An
// erase removes the key with every other `limelog.` key (dataRights); deleting
// an account also drops its slot by id (dataRights.deleteAccount).
//
// No store imports: dataRights uses this too. The stores are updated by the
// clear's caller side (accountWipe.ts).
//
// The discard tombstones (`wt_session_tombstones`) stay where they are: they
// only stop discarded workouts coming back from the cloud, and clearing them
// would bring those back.
import { storage } from '@/utils/storage';
import type { ExercisePR } from '@/types/logging';
import type { UserProfile } from '@/types/user';

export const PARKED_KEY = 'limelog.parked';
const PRS_KEY = 'wt_exercise_prs';
const PROFILE_KEY = 'wt_profile';
export const MAX_SLOTS = 5;

export interface ParkedSlot {
  prs: ExercisePR[];
  profile: UserProfile | null;
  parkedAt: string;
}

type Parked = Record<string, ParkedSlot>;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function readParked(): Parked {
  const p = readJson<Parked>(PARKED_KEY);
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/** Writes the slots, the newest MAX_SLOTS only. Throws when storage refuses. */
function writeParked(p: Parked): void {
  const sorted = Object.entries(p).sort(([, a], [, b]) => String(b.parkedAt).localeCompare(String(a.parkedAt)));
  const kept = sorted.slice(0, MAX_SLOTS);
  for (const [id, slot] of sorted.slice(MAX_SLOTS)) {
    console.warn(`[parked] more than ${MAX_SLOTS} accounts set aside; dropping the oldest, ${id} (set aside ${slot.parkedAt})`);
  }
  if (kept.length === 0) localStorage.removeItem(PARKED_KEY);
  else localStorage.setItem(PARKED_KEY, JSON.stringify(Object.fromEntries(kept)));
}

function joinPRs(a: ExercisePR[], b: ExercisePR[]): ExercisePR[] {
  const seen = new Set(a.map((p) => p.id));
  return [...a, ...b.filter((p) => !seen.has(p.id))];
}

/** `primary` with the restrictions only `secondary` has added after its own:
 *  they are about someone's body, so none is dropped. */
function joinProfiles(primary: UserProfile | null, secondary: UserProfile | null): UserProfile | null {
  if (!primary || !secondary) return primary ?? secondary;
  const ids = new Set(primary.activeRestrictions.map((r) => r.id));
  return {
    ...primary,
    activeRestrictions: [
      ...primary.activeRestrictions,
      ...secondary.activeRestrictions.filter((r) => !ids.has(r.id)),
    ],
  };
}

/** The slot set aside for `userId`, if any. */
export function parkedFor(userId: string): ParkedSlot | null {
  return readParked()[userId] ?? null;
}

/**
 * Move the live records and profile into `userId`'s slot and empty them on
 * the device. Part of the account clear. Returns false when the move did not
 * happen: a slot that cannot be written (storage full, though the clear has
 * just removed the photos) leaves the records and profile live rather than
 * losing them (they exist only here), and an account switch then waits and
 * tries again (accountOwner.ts), as for any part of the clear that failed.
 *
 * A slot already there (one never put back) is joined, not replaced: its
 * profile is the account's own and wins over the live one, which may be a
 * guest's made since; records are joined by id.
 */
export function parkAccountData(userId: string): boolean {
  const prs = readJson<ExercisePR[]>(PRS_KEY) ?? [];
  const profile = readJson<UserProfile>(PROFILE_KEY);
  if (prs.length > 0 || profile) {
    try {
      const all = readParked();
      const before = all[userId];
      all[userId] = {
        prs: before ? joinPRs(before.prs ?? [], prs) : prs,
        profile: joinProfiles(before?.profile ?? null, profile),
        parkedAt: new Date().toISOString(),
      };
      writeParked(all);
    } catch (e) {
      console.warn('[parked] could not set the records and profile aside; keeping them on the device:', e);
      return false;
    }
  }
  try {
    localStorage.removeItem(PRS_KEY);
    localStorage.removeItem(PROFILE_KEY);
    return true;
  } catch (e) {
    console.warn('[parked] could not remove the records and profile from the device:', e);
    return false;
  }
}

/**
 * Put `userId`'s slot back into the live keys (see the top of the file for
 * how it joins what is already there), then drop it. Returns what is now
 * live, for the stores; null when there was no slot, or when its write
 * failed (the slot is then kept for the next time).
 */
export function restoreParked(userId: string): { prs: ExercisePR[]; profile: UserProfile | null } | null {
  const all = readParked();
  const slot = all[userId];
  if (!slot) return null;
  const livePRs = storage.getExercisePRs();
  const prs = joinPRs(livePRs, Array.isArray(slot.prs) ? slot.prs : []);
  const profile = joinProfiles(slot.profile ?? null, storage.getProfile());
  try {
    if (prs.length > 0) storage.setExercisePRs(prs);
    if (profile) storage.setProfile(profile);
  } catch {
    // storage.set has logged it (and told the user when storage is full).
    return null;
  }
  forgetParked(userId);
  return { prs: storage.getExercisePRs(), profile };
}

/** Drop `userId`'s slot (account deleted, or put back). */
export function forgetParked(userId: string): void {
  try {
    const all = readParked();
    if (!(userId in all)) return;
    delete all[userId];
    writeParked(all);
  } catch (e) {
    console.warn('[parked] could not drop a slot:', e);
  }
}
