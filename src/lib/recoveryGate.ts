// v1.18.1 (LimeLog#85) — when the Nexus recovery pull (nexusRecovery.ts) runs.
//
// It ran once per launch, behind a ref in App.tsx. Sign-out wipes the local
// workout history, so signing out and back in during one launch (as yourself
// or as someone else) left the history empty until a restart: the pull had
// already been spent.
//
// Now it runs once per sign-in. The key is the account id, and it is released
// by a sign-out, so:
//   - a new sign-in, of another account or of the same one after a sign-out,
//     pulls again;
//   - a token refresh, a resume (auth-js emits SIGNED_IN when the app comes
//     back) or an email change reports the same id with no sign-out between,
//     and does not.
//
// A pull belongs to the sign-in it started for. A sign-out that begins while
// it runs, or another account signing in, makes its result stale, and a stale
// result is dropped: it must not refill the store a sign-out just emptied, or
// put one account's workouts in front of the next.
//
// No imports beyond types, so the rules are testable on their own; App.tsx
// wires in the stores and the pull.

import type { SessionLog } from '@/types/logging';

/** The slice of nexusStore the gate reads. */
export interface RecoveryAuthState {
  configured: boolean;
  userId: string | null;
  sessionUnverified: boolean;
  signingOut: boolean;
  signOutPending: boolean;
}

export interface RecoveryGateDeps {
  read: () => RecoveryAuthState;
  /** Fetch the cloud workouts of `userId`. */
  pull: (userId: string) => Promise<SessionLog[]>;
  /** Reinstate what is missing locally; returns how many were added. */
  apply: (logs: SessionLog[]) => number;
  /** How the pull is started after `evaluate()` returns. Default: a 0 ms
   *  timer. `evaluate()` runs from a store subscription, and the auth
   *  listener sets that store while auth-js holds its lock; the pull asks
   *  auth-js for the user, so starting it in the same turn would wait on the
   *  lock the listener holds. recordAppOpen is deferred there for the same
   *  reason. */
  defer?: (start: () => void) => void;
}

export interface RecoveryGate {
  /** Look at the auth state and start a pull if this sign-in has not had
   *  one. Synchronous and cheap: call it on every store change. */
  evaluate: () => void;
}

interface Run {
  userId: string;
}

export function createRecoveryGate(deps: RecoveryGateDeps): RecoveryGate {
  const defer = deps.defer ?? ((start: () => void) => void setTimeout(start, 0));
  /** The account whose sign-in has had its pull. Null after a sign-out. */
  let pulledFor: string | null = null;
  /** The pull whose result may still be written. */
  let current: Run | null = null;

  const stillCurrent = (run: Run): boolean => {
    if (current !== run) return false;
    const s = deps.read();
    return s.userId === run.userId && !s.signingOut && !s.signOutPending;
  };

  const execute = async (run: Run): Promise<void> => {
    if (!stillCurrent(run)) return;
    try {
      const cloudSessions = await deps.pull(run.userId);
      if (!stillCurrent(run)) {
        console.warn('[recovery] signed out or switched account during the pull; result dropped');
        return;
      }
      const restored = deps.apply(cloudSessions);
      if (restored > 0) {
        console.log(`[recovery] reinstated ${restored} workout(s) from cloud`);
      }
    } catch (e) {
      if (!stillCurrent(run)) return;
      // Not retried until the next sign-in or launch, as before.
      console.warn('[recovery] workout hydrate failed:', (e as Error).message);
    }
  };

  return {
    evaluate() {
      const s = deps.read();
      // Signed out, or signing out: release the key so the next sign-in pulls,
      // and orphan any pull in flight so its result is dropped.
      if (!s.userId || s.signingOut) {
        pulledFor = null;
        current = null;
        return;
      }
      // v1.19 — LL#64: an unconfirmed stored session waits to be confirmed,
      // so an offline start does not spend the pull before it can work.
      if (!s.configured || s.sessionUnverified || s.signOutPending) return;
      if (pulledFor === s.userId) return;
      // A new sign-in. If another account's pull is still running (signed in
      // over it, with no sign-out between), this replaces it.
      pulledFor = s.userId;
      const run: Run = { userId: s.userId };
      current = run;
      defer(() => void execute(run));
    },
  };
}
