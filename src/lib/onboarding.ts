// v1.7 — first-run onboarding flag + training-goal seed.
//
// The onboarding wizard (OnboardingFlow) shows once on a fresh install, after
// the auth gate, when the user has no logged sessions yet. We persist a
// "completed" flag so skipping/finishing it doesn't re-show on every cold
// start (the session-count gate alone would re-trigger for a user who skipped
// without logging anything).
//
// The chosen training goal is informational for now (per the v1.6 plan, Q3 →
// "display only") — seeds a narrative context for a future AI debrief prompt,
// no logic gate. Stored locally; not synced.

import { supabase } from '@/lib/supabase';

const DONE_KEY = 'limelog.onboarded';
const GOAL_KEY = 'limelog.trainingGoal';
// v1.18.1 (LimeLog#82) — the two values of DONE_KEY that mean done. '1': done
// by whoever uses the device now (signed in, or a guest). SIGNED_OUT: done by
// an account that has since signed out. Both keep the wizard away from a
// guest; only the second is reset by the next account's definite "no".
const DONE = '1';
const DONE_BY_SIGNED_OUT = 'signed-out';

export type TrainingGoal = 'strength' | 'hypertrophy' | 'sport' | 'general';

function doneValue(): string | null {
  try {
    return localStorage.getItem(DONE_KEY);
  } catch {
    return null;
  }
}

export function isOnboarded(): boolean {
  const v = doneValue();
  return v === DONE || v === DONE_BY_SIGNED_OUT;
}

export function setOnboarded(): void {
  try {
    localStorage.setItem(DONE_KEY, DONE);
  } catch {
    /* best-effort flag */
  }
}

export function setTrainingGoal(goal: TrainingGoal): void {
  try {
    localStorage.setItem(GOAL_KEY, goal);
  } catch {
    /* best-effort */
  }
}

/** v1.18.1 (LimeLog#82) — sign-out. Kept as they were, the next person on a
 *  shared phone skipped the wizard and inherited someone else's goal.
 *
 *  - The goal goes: it is the person's answer, local only, and nothing reads
 *    it yet (display-only, see the header).
 *  - The flag is NOT removed. Removed, the person carrying on as a guest got
 *    the wizard at the next launch, with no account to say otherwise. It is
 *    re-marked as the signed-out account's instead: still done for a guest,
 *    but the next account's definite "no" resets it at sign-in
 *    (`hydrateOnboardedFromCloud`), where a plain '1' is taken as this
 *    person's and back-filled to their account. */
export function releaseOnboardingOnSignOut(): void {
  try {
    localStorage.removeItem(GOAL_KEY);
    if (localStorage.getItem(DONE_KEY) === DONE) localStorage.setItem(DONE_KEY, DONE_BY_SIGNED_OUT);
  } catch {
    /* no storage: nothing was kept */
  }
}

// -- v1.10: the flag belongs to the ACCOUNT, not the device ----------------
// It was localStorage and nothing else, which is per-origin and per-device, so
// a returning user on a new phone, browser or reinstall - or, until today's
// Electron origin fix, just the next launch of the desktop build - looked
// brand new and was made to redo the wizard.
//
// localStorage stays the fast path and the only path for guests: it answers
// synchronously on first render. The cloud read is a correction layer that can
// only ever turn the wizard OFF. A failed network call therefore falls back to
// the local answer - showing the wizard to someone who has seen it is annoying,
// but hiding first-run setup from someone who needs it would be worse.

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Record completion against the account. Best-effort: the local flag is
 *  already set by the caller, so a failure costs a repeat wizard on the NEXT
 *  device, not a broken finish on this one. */
export async function markOnboardedCloud(): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  try {
    const { error } = await supabase.from('user_preferences').upsert(
      { user_id: userId, limelog_onboarded: true, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
    if (error) console.warn('[onboarding] cloud write failed:', error.message);
  } catch (e) {
    console.warn('[onboarding] cloud write threw:', (e as Error).message);
  }
}

/** v1.18.1 (LimeLog#82) — 'unknown' is apart from 'no'. A failed or
 *  unreachable ask used to read as "not done", which the caller could not
 *  tell from the account saying so; acting on it showed the wizard to an
 *  onboarded user on a bad network. */
export type OnboardedAnswer = 'yes' | 'no' | 'unknown';

/** Has the signed-in user onboarded? Writes the answer to the local flag on
 *  a definite yes or no only. Also back-fills a device that says done ('1')
 *  while the account does not know yet, so the first run of this version is
 *  the last time the wizard ever appears. */
export async function hydrateOnboardedFromCloud(): Promise<OnboardedAnswer> {
  const userId = await currentUserId();
  if (!userId) return 'unknown'; // getUser failed: called only while signed in
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('limelog_onboarded')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return 'unknown';
    if (data?.limelog_onboarded) {
      setOnboarded();
      return 'yes';
    }
    // The account says no. A plain '1' is this person's own finish (as a
    // guest before signing in, or a cloud write that failed): tell the
    // account. The signed-out account's mark, or nothing, means not done.
    if (doneValue() === DONE) {
      await markOnboardedCloud();
      return 'yes';
    }
    try { localStorage.removeItem(DONE_KEY); } catch { /* best effort */ }
    return 'no';
  } catch {
    return 'unknown';
  }
}
