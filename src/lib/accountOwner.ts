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
// One import, a leaf: the outbox reads this before every send, and the clear
// itself (which needs the stores) is registered by nexusStore.
//
// v1.18.1 (LimeLog#92) — the record is mirrored into Capacitor Preferences.
// localStorage is where the progress photos live (data URLs), so it can be
// full; the record could then not be written, and the next launch found no
// owner, so a different account signing in took the previous one's data up.
// Preferences is Android SharedPreferences, outside the WebView's quota.
// Writes go to both (Preferences in the background, in order, failures
// logged); reads stay synchronous: loadOwnerRecord() reads Preferences once at
// launch, before the first take-up (nexusStore.init), and when localStorage
// has no record it uses the mirrored one. On the web Preferences is itself
// localStorage (under `CapacitorStorage.`), so there the mirror adds nothing,
// which is acceptable: the quota problem is the Android WebView's.
import { Preferences } from '@capacitor/preferences';

export const OWNER_KEY = 'limelog.dataOwner';
/** v1.18.1 (LimeLog#91) — the owner's email, so "Continue as guest" after a
 *  session that ended without a sign-out can say whose data is on the device
 *  (the stored session is gone by then). Local only, cleared with the record. */
export const OWNER_EMAIL_KEY = 'limelog.dataOwnerEmail';

interface OwnerHooks {
  /** Clears the local data of the previous account, `previousOwner`.
   *  Returns false when any part of it did not happen. */
  wipe: (previousOwner: string) => boolean;
  /** True while a sign-out runs: no account takes the data up meanwhile. */
  paused?: () => boolean;
  /** v1.18.1 (LimeLog#90) — `userId` owns the data now: put back what was
   *  set aside for it when it last left. Cheap when nothing was. */
  restore?: (userId: string) => void;
  /** v1.18.1 (LimeLog#92) — a mirror read that outlasted the launch's wait
   *  has settled: take-ups refused meanwhile can be tried again. */
  recordSettled?: () => void;
}

let hooks: OwnerHooks | null = null;

/** The owner for this launch when storage refused to record it (full: the
 *  progress photos are data URLs in localStorage). Without it the outbox,
 *  which compares against the record before every send, would stop syncing
 *  for the account that is signed in. Cleared with the record. */
let memoryOwner: string | null = null;
let memoryEmail: string | null = null;
/** Set by any write or clear, so a Preferences read that answers late does
 *  not overwrite a newer record (loadOwnerRecord). */
let touched = false;
/** v1.18.1 (LimeLog#92) — true while localStorage has no record and the
 *  mirror has not answered. Nothing takes the data up meanwhile: the mirror
 *  may name another account, whose data (and queue) it is. */
let recordPending = false;
let recordRead: Promise<void> = Promise.resolve();

/** Wire in the clear. Called once by nexusStore at module load. */
export function configureAccountOwner(h: OwnerHooks | null): void {
  hooks = h;
}

// Preferences writes run one after another, so a set and the clear that
// follows it cannot land out of order.
let mirrorQueue: Promise<void> = Promise.resolve();
function mirror(key: string, value: string | null): void {
  mirrorQueue = mirrorQueue
    .then(() => (value === null ? Preferences.remove({ key }) : Preferences.set({ key, value })))
    .catch((e: unknown) => {
      console.warn('[owner] could not mirror the account record to Preferences:', e);
    });
}

/** Resolves when the Preferences writes queued so far have settled, or after
 *  `timeoutMs` at most (a reload waits on it: dataRights.deleteAccount). */
export async function ownerMirrorSettled(timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([mirrorQueue, new Promise<void>((res) => { timer = setTimeout(res, timeoutMs); })]);
  clearTimeout(timer);
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` in localStorage; false when storage refused. */
function writeLocal(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[owner] could not record the account the local data belongs to; keeping it for this launch:', e);
    // The old record goes, if it can, so it cannot contradict the new one.
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing more to do */
    }
    return false;
  }
}

/**
 * v1.18.1 (LimeLog#92) — read the mirrored record once, at launch, before the
 * first take-up. localStorage wins when it has a record (it is written first,
 * synchronously, so it is never older); the mirror is then brought in line.
 * When it has none, the mirror's record is the owner (held in memory, and
 * written back to localStorage if there is room). Bounded: a launch does not
 * wait on it for more than `timeoutMs`.
 */
export async function loadOwnerRecord(timeoutMs = 1500): Promise<void> {
  // A record here is the newest there is: no take-up has to wait for the
  // mirror, which is only brought in line.
  recordPending = readLocal(OWNER_KEY) === null && memoryOwner === null;
  const read = (async () => {
    const [owner, email] = await Promise.all([
      Preferences.get({ key: OWNER_KEY }).then((r) => r.value ?? null),
      Preferences.get({ key: OWNER_EMAIL_KEY }).then((r) => r.value ?? null),
    ]);
    return { owner, email };
  })().catch((e: unknown) => {
    console.warn('[owner] could not read the mirrored account record:', e);
    return null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), timeoutMs);
  });
  const raced = await Promise.race([read.then((r) => ({ r })), timeout]);
  clearTimeout(timer);
  if (raced) {
    applyMirrored(raced.r);
    recordPending = false;
    return;
  }
  // Timed out: the launch goes on, and take-ups stay refused (no claim, no
  // send, no recovery pull) until the read settles, then are tried again.
  console.warn('[owner] the mirrored account record has not been read yet; taking the data up waits for it');
  recordRead = read.then((r) => {
    applyMirrored(r);
    recordPending = false;
    hooks?.recordSettled?.();
  });
}

/** Resolves once the mirrored record is known (at once unless the launch's
 *  read outlasted its wait), or after `timeoutMs` at most. */
export async function ownerRecordKnown(timeoutMs = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([recordRead, new Promise<void>((res) => { timer = setTimeout(res, timeoutMs); })]);
  clearTimeout(timer);
}

function applyMirrored(found: { owner: string | null; email: string | null } | null): void {
  if (!found || touched) return;
  const local = readLocal(OWNER_KEY);
  if (local !== null) {
    if (found.owner !== local) mirror(OWNER_KEY, local);
    const localEmail = readLocal(OWNER_EMAIL_KEY);
    if (localEmail !== null && found.email !== localEmail) mirror(OWNER_EMAIL_KEY, localEmail);
    return;
  }
  if (found.owner === null) return;
  console.warn('[owner] no account record in local storage; using the mirrored one');
  memoryOwner = writeLocal(OWNER_KEY, found.owner) ? null : found.owner;
  if (found.email !== null) memoryEmail = writeLocal(OWNER_EMAIL_KEY, found.email) ? null : found.email;
}

export function readOwner(): string | null {
  if (memoryOwner !== null) return memoryOwner;
  return readLocal(OWNER_KEY);
}

/** v1.18.1 (LimeLog#91) — the owner's email, when one was recorded. */
export function readOwnerEmail(): string | null {
  if (memoryEmail !== null) return memoryEmail;
  return readLocal(OWNER_EMAIL_KEY);
}

/** Records `userId`. False when storage refused; the owner is then held in
 *  memory for this launch, and the old record is removed if it can be, so the
 *  next launch finds no owner (and takes the data up) rather than a previous
 *  account (and clears the current account's data). The Preferences mirror
 *  (LimeLog#92) gets the new owner either way, so the next launch finds it
 *  there. */
function writeOwner(userId: string): boolean {
  touched = true;
  mirror(OWNER_KEY, userId);
  const ok = writeLocal(OWNER_KEY, userId);
  memoryOwner = ok ? null : userId;
  return ok;
}

function writeOwnerEmail(email: string | null): void {
  touched = true;
  mirror(OWNER_EMAIL_KEY, email);
  if (email === null) {
    memoryEmail = null;
    try {
      localStorage.removeItem(OWNER_EMAIL_KEY);
    } catch {
      /* nothing was kept */
    }
    return;
  }
  memoryEmail = writeLocal(OWNER_EMAIL_KEY, email) ? null : email;
}

export function clearOwner(): void {
  touched = true;
  memoryOwner = null;
  memoryEmail = null;
  mirror(OWNER_KEY, null);
  mirror(OWNER_EMAIL_KEY, null);
  try {
    localStorage.removeItem(OWNER_KEY);
    localStorage.removeItem(OWNER_EMAIL_KEY);
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
export function adoptLocalData(userId: string | null | undefined, email?: string | null): boolean {
  if (!userId) return false;
  // v1.18.1 (LimeLog#92) — not before the mirrored record is known.
  if (recordPending) return false;
  const owner = readOwner();
  if (owner === userId) {
    // The address can change under the same account; keep the one shown
    // by "Continue as guest" current (LimeLog#91).
    if (email && readOwnerEmail() !== email) writeOwnerEmail(email);
    // v1.18.1 (LimeLog#90) — a slot of this account's can still be there:
    // a restore whose write failed, or a launch that found this owner in the
    // mirror after a sign-out whose clear of it did not land.
    restore(userId);
    return true;
  }
  if (hooks?.paused?.()) return false;
  if (owner !== null) {
    if (!hooks) return false;
    // The new owner is written only after a clear that fully succeeded. One
    // that failed part-way leaves the previous account recorded, so nothing
    // is sent or pulled for this one until a later call clears it.
    if (!hooks.wipe(owner)) {
      console.warn('[owner] the previous account\'s local data could not be fully cleared; sync waits');
      return false;
    }
  }
  // A failed write still makes `userId` the owner for this launch (memory).
  writeOwner(userId);
  writeOwnerEmail(email ?? null);
  restore(userId);
  return true;
}

function restore(userId: string): void {
  try {
    hooks?.restore?.(userId);
  } catch (e) {
    console.warn('[owner] could not put back the data set aside for this account:', e);
  }
}
