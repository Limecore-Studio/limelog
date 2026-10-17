// v1.18.1 (LimeLog#88) — which account the local data on this device belongs
// to. Same pattern as StudyDesk's deviceOwner.js (StudyDesk#162).
//
// Only an explicit sign-out cleared the local data. A session can also end
// without one: auth-js emits SIGNED_OUT after the server refuses the refresh
// token (a password change elsewhere, a session ended on the server). The
// workouts, body metrics, photo index, per-person flags and the outbox stayed,
// and nothing said whose they were, so the next account to sign in was shown
// them, its recovery pull added its own history on top, and the outbox sent
// the first account's queued changes under the second account.
//
// Now the owner is recorded when a session is taken up, and a session of a
// DIFFERENT account first clears the local data (the same clear as sign-out,
// accountWipe.ts) before anything is pulled or sent. Rules:
//   - same account again: kept, unsent changes included; they are its own;
//   - no owner yet (first sign-in, a guest's data, an explicit sign-out that
//     already cleared it): taken up as it is, as before this change;
//   - the session ending without a sign-out changes nothing here: whoever
//     signs in next decides, so signing back in as the same account keeps
//     the work done offline.
// An explicit sign-out clears the record with the data (nexusStore.signOut);
// an erase removes it with every other `limelog.` key (dataRights).
//
// No imports: the outbox reads this before every send, and the clear itself
// (which needs the stores) is registered by nexusStore.

export const OWNER_KEY = 'limelog.dataOwner';

interface OwnerHooks {
  /** Clears the local data of the previous account. Returns false when any
   *  part of it did not happen. */
  wipe: () => boolean;
  /** True while a sign-out runs: no account takes the data up meanwhile. */
  paused?: () => boolean;
}

let hooks: OwnerHooks | null = null;

/** The owner for this launch when storage refused to record it (full: the
 *  progress photos are data URLs in localStorage). Without it the outbox,
 *  which compares against the record before every send, would stop syncing
 *  for the account that is signed in. Cleared with the record. */
let memoryOwner: string | null = null;

/** Wire in the clear. Called once by nexusStore at module load. */
export function configureAccountOwner(h: OwnerHooks | null): void {
  hooks = h;
}

export function readOwner(): string | null {
  if (memoryOwner !== null) return memoryOwner;
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

/** Records `userId`. False when storage refused; the owner is then held in
 *  memory for this launch, and the old record is removed if it can be, so the
 *  next launch finds no owner (and takes the data up) rather than a previous
 *  account (and clears the current account's data). */
function writeOwner(userId: string): boolean {
  try {
    localStorage.setItem(OWNER_KEY, userId);
    memoryOwner = null;
    return true;
  } catch (e) {
    console.warn('[owner] could not record the account the local data belongs to; keeping it for this launch:', e);
    try {
      localStorage.removeItem(OWNER_KEY);
    } catch {
      /* nothing more to do */
    }
    memoryOwner = userId;
    return false;
  }
}

export function clearOwner(): void {
  memoryOwner = null;
  try {
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* no storage: nothing was kept */
  }
}

/**
 * Make `userId` the owner of the local data, clearing it first if it was
 * another account's. Idempotent; cheap when the owner already matches.
 *
 * Returns true when the local data is now `userId`'s, so it may be sent or
 * added to under that account. False means it is not: no id, a sign-out is
 * running, or the data is another account's and could not be cleared (no
 * clear wired in, or the clear failed part-way). Callers that send or pull
 * must then do neither; the next call tries the clear again.
 */
export function adoptLocalData(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const owner = readOwner();
  if (owner === userId) return true;
  if (hooks?.paused?.()) return false;
  if (owner !== null) {
    if (!hooks) return false;
    // The new owner is written only after a clear that fully succeeded. One
    // that failed part-way leaves the previous account recorded, so nothing
    // is sent or pulled for this one until a later call clears it.
    if (!hooks.wipe()) {
      console.warn('[owner] the previous account\'s local data could not be fully cleared; sync waits');
      return false;
    }
  }
  // A failed write still makes `userId` the owner for this launch (memory).
  writeOwner(userId);
  return true;
}
