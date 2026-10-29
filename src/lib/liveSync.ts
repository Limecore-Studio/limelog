// v1.20 (LimeLog#110) — when live sync runs, and what a hint does.
//
// Live sync runs for the same account the recovery pull trusts: signed in,
// session confirmed, not signing out, and the owner of the local data
// (recoveryGate.ts, accountOwner.ts). Anything else stops it. Driven by a store
// subscription from App.tsx, like the recovery gate.
//
// A hint for workouts from another device runs the same pull as recovery and
// reinstates what is missing (the engine's `refresh`); `recoverSessions` adds
// by id and skips local tombstones, so running it again is harmless and queues
// nothing. A pull that finishes after the account changed is dropped, as in the
// recovery gate.
//
// Pushes are announced from the outbox's pushed listener.
//
// No imports beyond types, so the rules are testable on their own; App.tsx
// wires in the stores, the pull and the engine (loaded on demand).

import type { SessionLog } from '@/types/logging';
import type { RecoveryAuthState } from './recoveryGate';
import type { LiveOptions } from './liveEngine';

export interface LiveEngine {
  startLive: (opts: LiveOptions) => void;
  stopLive: () => void;
  announceChanged: (tables: string[]) => void;
}

export interface LiveSyncDeps {
  read: () => RecoveryAuthState;
  /** True once the local data has been taken up by `userId`. */
  ready: (userId: string) => boolean;
  pull: (userId: string) => Promise<SessionLog[]>;
  apply: (logs: SessionLog[]) => number;
  load: () => Promise<LiveEngine>;
  onPushed: (listener: (tables: string[]) => void) => () => void;
}

export function createLiveSync(deps: LiveSyncDeps) {
  let engine: LiveEngine | null = null;
  let current: string | null = null;

  const eligible = (): string | null => {
    const s = deps.read();
    if (!s.configured || !s.userId || s.sessionUnverified || s.signingOut || s.signOutPending) return null;
    return deps.ready(s.userId) ? s.userId : null;
  };

  deps.onPushed((tables) => engine?.announceChanged(tables));

  return {
    evaluate(): void {
      const userId = eligible();
      if (userId === current) return;
      current = userId;
      if (!userId) {
        engine?.stopLive();
        return;
      }
      void deps
        .load()
        .then((m) => {
          engine = m;
          if (current !== userId) return;
          m.startLive({ userId, isCurrent: () => eligible() === userId, pull: deps.pull, apply: deps.apply });
        })
        .catch((e) => console.warn('[live] failed to load:', e instanceof Error ? e.message : e));
    },
    /** For tests: the user live sync is running for. */
    get userId(): string | null {
      return current;
    },
  };
}
