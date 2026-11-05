// v1.20 (LimeLog#110 item 1, the owner's option (a), 2026-10-30) — a workout
// in progress is pushed as its sets are logged, not only at Finish, so NCC and
// the user's other devices see it within a second through the live hint.
// Accepted with it: every NCC build counts the workout from its first completed
// set, and on an NCC older than 1.16 a discarded one stays visible.
//
// Debounced per workout, so a burst of edits is one push. The payload is the
// whole workout (the same mapping Finish uses), so a newer push replaces any
// older one still waiting in the outbox, and the deterministic set ids of
// limelog#28 keep repeated pushes to the same rows. Nothing is pushed until a
// set is completed: an opened-and-abandoned workout never reaches the cloud.
// Cardio has no in-progress state (logCardio finishes at once).
//
// Loaded on the first logged set (logStore.ts), not at startup: the startup
// bundle has no room for it. That is safe because the push re-reads the
// workout when it fires, so one finished or discarded meanwhile is left alone
// even if Finish ran before this module had loaded.
import { useLogStore } from '@/store/logStore';
import { useProgramStore } from '@/store/programStore';
import { useNexusStore } from '@/store/nexusStore';
import { mapSessionLogToNexus } from '@/lib/nexusSync';
import { enqueue, cancel as cancelQueued } from '@/lib/outbox';

const LIVE_PUSH_MS = 300;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function schedule(logId: string): void {
  cancel(logId);
  timers.set(logId, setTimeout(() => {
    timers.delete(logId);
    pushInProgress(logId);
  }, LIVE_PUSH_MS));
}

export function cancel(logId: string): void {
  const pending = timers.get(logId);
  if (pending) clearTimeout(pending);
  timers.delete(logId);
}

/** Push now whatever is waiting: the app is going to the background, where
 *  the OS may kill it before a timer fires. */
export function flush(): void {
  for (const logId of [...timers.keys()]) {
    cancel(logId);
    pushInProgress(logId);
  }
}

function pushInProgress(logId: string): void {
  const log = useLogStore.getState().sessionLogs.find((l) => l.id === logId);
  // Finished meanwhile (Finish queued its own push) or discarded: nothing to do.
  if (!log || log.finalizedAt || log.activityType) return;
  if (!log.sets.some((s) => s.completed)) return;
  const nexus = useNexusStore.getState();
  if (!nexus.configured || !nexus.syncEnabled) return;
  const { exercises, activeProgram } = useProgramStore.getState();
  const session = activeProgram?.sessions.find((s) => s.id === log.sessionTemplateId);
  cancelQueued('upsert_workout_session', (p) => p.sessionId === logId);
  enqueue('upsert_workout_session', mapSessionLogToNexus(log, session, exercises));
  nexus.refreshPendingCount();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
