import { create } from 'zustand';
import { storage } from '@/utils/storage';
import { generateId } from '@/utils/helpers';
import type { SessionLog, SetLog, VerticalJumpLog, StallFlag, StallFlagType, SessionMood, ExercisePR, CardioActivity } from '@/types/logging';
import { useProgramStore } from '@/store/programStore';
import { useNexusStore } from '@/store/nexusStore';
import { mapSessionLogToNexus } from '@/lib/nexusSync';
import { enqueue as outboxEnqueue, cancel as outboxCancel } from '@/lib/outbox';
import { detectNewPRs, currentPR } from '@/lib/prDetection';

interface LogStore {
  sessionLogs: SessionLog[];
  jumpLogs: VerticalJumpLog[];
  stallFlags: StallFlag[];
  // v1.6 — append-only Personal Records (one row per achievement).
  exercisePRs: ExercisePR[];
  // PRs detected on the most recent finalize, awaiting the celebration modal.
  // null when there's nothing to celebrate. Cleared by clearCelebratedPRs.
  lastCelebratedPRs: ExercisePR[] | null;

  // Session logging
  startSession: (sessionTemplateId: string, programId: string) => SessionLog;
  /** v1.9 (Item 4) — log a finished cardio activity in one step. */
  logCardio: (input: {
    activityType: CardioActivity;
    durationSeconds: number;
    /** Metres. Omit for activities where distance means nothing. */
    distanceMeters?: number;
    notes?: string;
    /** ISO timestamp; defaults to now. Lets the user log yesterday's run. */
    when?: string;
  }) => SessionLog;
  updateSessionNote: (logId: string, notes: string) => void;
  setPerceivedFatigue: (logId: string, fatigue: number) => void;
  setSessionDebrief: (
    logId: string,
    debrief: {
      raw: string;
      rpe: number | null;
      painFlags: string[];
      mood: SessionMood | null;
      noteSummary: string;
    } | null,
  ) => void;
  finalizeSession: (logId: string) => void;
  unfinalizeSession: (logId: string) => void;
  discardSession: (logId: string) => void;

  // v1.7 (BUG-6) — recovery hydrate. Insert reconstructed cloud sessions whose
  // id is neither present locally nor tombstoned by a prior discard. Never
  // overwrites or deletes a local session. Returns the count actually inserted.
  recoverSessions: (incoming: SessionLog[]) => number;

  // Set logging
  logSet: (logId: string, set: Omit<SetLog, 'id' | 'sessionLogId'>) => void;
  updateSet: (logId: string, setId: string, updates: Partial<SetLog>) => void;
  deleteSet: (logId: string, setId: string) => void;
  /** v1.15 Item 8 — use `toExerciseId` for one programmed slot in this
   *  workout only. Passing the programmed exercise clears the swap. */
  swapExercise: (logId: string, sessionExerciseId: string, programmedExerciseId: string, toExerciseId: string) => void;

  // Jump logging
  logJump: (j: Omit<VerticalJumpLog, 'id'>) => void;
  deleteJump: (id: string) => void;

  // Stall flags
  checkAndFlagStalls: (exerciseId: string) => void;
  resolveFlag: (flagId: string, action: StallFlag['resolutionAction']) => void;

  // PRs
  clearCelebratedPRs: () => void;
  currentPRFor: (exerciseId: string) => ExercisePR | null;
  prHistoryFor: (exerciseId: string) => ExercisePR[];
  prsForSession: (sessionId: string) => ExercisePR[];

  // Selectors
  getSetsForExercise: (exerciseId: string) => SetLog[];
  getLastSessionLog: (sessionTemplateId: string) => SessionLog | null;
}

// v1.18.1 (LimeLog#72) — a PR belongs to the finished workout it was detected
// in. Undo reopens that workout and Discard deletes it, so both retract its
// PRs: dropped here and deleted upstream. They used to stay for good, so a
// typo'd 1000 kg fixed after Undo, or a discarded workout, left a phantom PR
// that every later lift was measured against. Finishing again detects them
// afresh against the PRs that remain. currentPR is derived from the rows, so it
// falls back to the best remaining one by itself.
function retractSessionPRs(logId: string): void {
  const { exercisePRs, lastCelebratedPRs } = useLogStore.getState();
  const gone = exercisePRs.filter((p) => p.sessionId === logId);
  if (gone.length === 0) return;
  const kept = exercisePRs.filter((p) => p.sessionId !== logId);
  storage.setExercisePRs(kept);
  useLogStore.setState({
    exercisePRs: kept,
    lastCelebratedPRs: lastCelebratedPRs?.some((p) => p.sessionId === logId) ? null : lastCelebratedPRs,
  });
  // An insert still queued is dropped whatever the sync setting.
  const ids = new Set(gone.map((p) => p.id));
  outboxCancel('upsert_exercise_pr', (p) => ids.has(p.id));
  // Same gate as the push in finalizeSession and the discard tombstone.
  const nexus = useNexusStore.getState();
  if (!nexus.configured || !nexus.syncEnabled) return;
  for (const pr of gone) outboxEnqueue('delete_exercise_pr', { id: pr.id });
  nexus.refreshPendingCount();
}

export const useLogStore = create<LogStore>((set, get) => ({
  sessionLogs: storage.getSessionLogs(),
  jumpLogs: storage.getJumpLogs(),
  stallFlags: storage.getStallFlags(),
  exercisePRs: storage.getExercisePRs(),
  lastCelebratedPRs: null,

  startSession: (sessionTemplateId, programId) => {
    const log: SessionLog = {
      id: generateId(),
      sessionTemplateId,
      programId,
      loggedAt: new Date().toISOString(),
      perceivedFatigue: null,
      sets: [],
    };
    const sessionLogs = [log, ...get().sessionLogs];
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
    return log;
  },

  // v1.9 (Item 4) — cardio is logged after the fact, not lived through, so
  // there is no in-progress state to enter: one form, one save.
  //
  // It creates the log and then calls the ordinary `finalizeSession` rather
  // than writing its own push. That path already owns persistence, the Nexus
  // payload mapping and the outbox enqueue; duplicating it here would mean two
  // places to fix the next time the sync contract moves. PR detection runs and
  // finds nothing, which is correct — a run has no sets to set a record on.
  logCardio: ({ activityType, durationSeconds, distanceMeters, notes, when }) => {
    const at = when ?? new Date().toISOString();
    const log: SessionLog = {
      id: generateId(),
      activityType,
      durationSeconds,
      distanceMeters,
      loggedAt: at,
      perceivedFatigue: null,
      notes,
      sets: [],
    };
    const sessionLogs = [log, ...get().sessionLogs];
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
    get().finalizeSession(log.id);
    return log;
  },

  updateSessionNote: (logId, notes) => {
    const sessionLogs = get().sessionLogs.map((l) => (l.id === logId ? { ...l, notes } : l));
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  setPerceivedFatigue: (logId, fatigue) => {
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId ? { ...l, perceivedFatigue: fatigue } : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  // v1.4 — store the analysed AI debrief on the session (before finalize, so
  // finalizeSession's push picks it up). Passing null clears it.
  setSessionDebrief: (logId, debrief) => {
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId
        ? {
            ...l,
            aiDebriefRaw: debrief?.raw ?? null,
            aiRpe: debrief?.rpe ?? null,
            aiPainFlags: debrief?.painFlags ?? null,
            aiMood: debrief?.mood ?? null,
            aiNoteSummary: debrief?.noteSummary ?? null,
          }
        : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  finalizeSession: (logId) => {
    const finalizedAt = new Date().toISOString();
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId ? { ...l, finalizedAt } : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });

    const finalizedLog = sessionLogs.find((l) => l.id === logId);
    if (!finalizedLog) return;

    const { exercises, activeProgram } = useProgramStore.getState();

    // v1.6 — Personal Records. Detection is local-first and runs regardless of
    // cloud config: a PR is a PR even offline / signed-out. The celebration
    // modal reads lastCelebratedPRs; the cloud push (below) only fires when
    // sync is on, mirroring the workout-session gate.
    const nameOf = (id: string) => exercises.find((e) => e.id === id)?.name ?? 'Exercise';
    const newPRs = detectNewPRs(finalizedLog, get().exercisePRs, nameOf, generateId);
    if (newPRs.length > 0) {
      const exercisePRs = [...newPRs, ...get().exercisePRs];
      storage.setExercisePRs(exercisePRs);
      set({ exercisePRs, lastCelebratedPRs: newPRs });
    }

    // v1.18.1 (LimeLog#75) — stall detection runs here, once per finished
    // workout, for each exercise it has completed sets of. It used to run on
    // every set tick against the workout still in progress.
    const done = new Set(finalizedLog.sets.filter((s) => s.completed).map((s) => s.exerciseId));
    for (const exerciseId of done) get().checkAndFlagStalls(exerciseId);

    const nexus = useNexusStore.getState();
    if (!nexus.configured || !nexus.syncEnabled) return;

    const session = activeProgram?.sessions.find((s) => s.id === finalizedLog.sessionTemplateId);
    const payload = mapSessionLogToNexus(finalizedLog, session, exercises);

    // v1.2 — route through outbox.enqueue instead of pushOrQueue. The
    // outbox handles persistence, single-flight drain, attempt cap, and
    // online/visibility re-triggering. nexusStore.refreshPendingCount reads
    // from the outbox's getStatus, so the Settings card stays accurate. We
    // optimistically stamp `lastPushAt` to the finalize time — the actual
    // network round-trip happens on the outbox drain, which may be moments
    // (online + signed in) or much later (offline / sign-in pending). The
    // UI's "last push" stamp tracks user intent more usefully than the
    // exact server-ack time.
    outboxEnqueue('upsert_workout_session', payload);
    // Push each new PR (push-only, append-only). Derived purely from the sets
    // just pushed — no new user input crosses the boundary.
    for (const pr of newPRs) {
      outboxEnqueue('upsert_exercise_pr', {
        id: pr.id,
        exerciseId: pr.exerciseId,
        exerciseName: pr.exerciseName,
        weightKg: pr.weightKg,
        reps: pr.reps,
        oneRepMaxKg: pr.oneRepMaxKg,
        sessionId: pr.sessionId,
        date: pr.date,
      });
    }
    const store = useNexusStore.getState();
    store.refreshPendingCount();
    store.setLastPushAt(finalizedAt);
  },

  unfinalizeSession: (logId) => {
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId ? { ...l, finalizedAt: undefined } : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
    retractSessionPRs(logId);
  },

  discardSession: (logId) => {
    const sessionLogs = get().sessionLogs.filter((l) => l.id !== logId);
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
    retractSessionPRs(logId);
    // v1.7 (BUG-6) — tombstone the discard so recovery-hydrate never resurrects
    // this workout from its still-present cloud row (push-only = no cloud
    // delete). Deduped; the list only grows with intentional discards.
    const tombstones = storage.getSessionTombstones();
    if (!tombstones.includes(logId)) {
      storage.setSessionTombstones([...tombstones, logId]);
    }
    // v1.16 (limelog#32) — and tombstone it in the cloud. The local list above
    // only protects THIS device: a workout finished (so pushed), then undone
    // and discarded, stayed live upstream, kept counting in NCC, and came back
    // on any other device's recovery. There is no telling here whether this
    // log ever reached the cloud (Undo clears finalizedAt), so the tombstone
    // is always sent; for a workout that was never pushed it matches no row.
    const nexus = useNexusStore.getState();
    if (nexus.configured && nexus.syncEnabled) {
      outboxEnqueue('delete_workout_session', { id: logId });
      nexus.refreshPendingCount();
    }
  },

  recoverSessions: (incoming) => {
    const existingIds = new Set(get().sessionLogs.map((l) => l.id));
    const tombstoned = new Set(storage.getSessionTombstones());
    const toAdd = incoming.filter((l) => !existingIds.has(l.id) && !tombstoned.has(l.id));
    if (toAdd.length === 0) return 0;
    // Prepend recovered sessions, then sort the whole set newest-first so the
    // history/list views stay ordered (recovered rows slot in by date).
    const sessionLogs = [...toAdd, ...get().sessionLogs].sort(
      (a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime(),
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
    return toAdd.length;
  },

  logSet: (logId, s) => {
    const newSet: SetLog = { ...s, id: generateId(), sessionLogId: logId };
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId ? { ...l, sets: [...l.sets, newSet] } : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  updateSet: (logId, setId, updates) => {
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId
        ? { ...l, sets: l.sets.map((s) => (s.id === setId ? { ...s, ...updates } : s)) }
        : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  deleteSet: (logId, setId) => {
    const sessionLogs = get().sessionLogs.map((l) =>
      l.id === logId ? { ...l, sets: l.sets.filter((s) => s.id !== setId) } : l
    );
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  swapExercise: (logId, sessionExerciseId, programmedExerciseId, toExerciseId) => {
    const sessionLogs = get().sessionLogs.map((l) => {
      if (l.id !== logId) return l;
      const from = l.exerciseSwaps?.[sessionExerciseId] ?? programmedExerciseId;
      if (from === toExerciseId) return l;
      // A COMPLETED set is a lift that happened and is never moved or dropped;
      // the page only offers a swap before one exists. Unfinished rows for the
      // outgoing exercise are dropped: their weights belong to a different
      // movement, and carrying 100 kg from a squat onto a leg press would be a
      // wrong default rather than a helpful one.
      const sets = l.sets.filter((s) => s.exerciseId !== from || s.completed);
      const swaps = { ...(l.exerciseSwaps ?? {}) };
      if (toExerciseId === programmedExerciseId) delete swaps[sessionExerciseId];
      else swaps[sessionExerciseId] = toExerciseId;
      return { ...l, sets, exerciseSwaps: Object.keys(swaps).length ? swaps : undefined };
    });
    storage.setSessionLogs(sessionLogs);
    set({ sessionLogs });
  },

  logJump: (j) => {
    const jump: VerticalJumpLog = { ...j, id: generateId() };
    const jumpLogs = [jump, ...get().jumpLogs];
    storage.setJumpLogs(jumpLogs);
    set({ jumpLogs });
  },

  deleteJump: (id) => {
    const jumpLogs = get().jumpLogs.filter((j) => j.id !== id);
    storage.setJumpLogs(jumpLogs);
    set({ jumpLogs });
  },

  checkAndFlagStalls: (exerciseId) => {
    // v1.18.1 (LimeLog#75): finished workouts and completed sets only. This
    // counted the workout in progress, unfinished rows included, so after two
    // flat sessions the first set of a third flagged a plateau, and the flag
    // stayed when the lifter then went on to add weight.
    const counts = (s: SetLog) => s.exerciseId === exerciseId && s.completed && s.weightKg !== null;
    const finished = get().sessionLogs.filter((l) => l.finalizedAt && l.sets.some(counts));
    if (finished.reduce((n, l) => n + l.sets.filter(counts).length, 0) < 9) return;

    const logs = finished
      .sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime())
      .slice(0, 3);

    if (logs.length < 3) return;

    const topWeights = logs.map((l) => Math.max(...l.sets.filter(counts).map((s) => s.weightKg!)));

    const isPlateaued = topWeights[0] <= topWeights[1] && topWeights[1] <= topWeights[2];
    if (!isPlateaued) return;

    const existing = get().stallFlags.find(
      (f) => f.exerciseId === exerciseId && !f.resolved
    );
    if (existing) return;

    const flagType: StallFlagType = 'weight_plateau';
    const flag: StallFlag = {
      id: generateId(),
      exerciseId,
      detectedAt: new Date().toISOString(),
      sessionLogIds: logs.map((l) => l.id),
      flagType,
      resolved: false,
    };
    const stallFlags = [...get().stallFlags, flag];
    storage.setStallFlags(stallFlags);
    set({ stallFlags });
  },

  resolveFlag: (flagId, action) => {
    const stallFlags = get().stallFlags.map((f) =>
      f.id === flagId ? { ...f, resolved: true, resolutionAction: action } : f
    );
    storage.setStallFlags(stallFlags);
    set({ stallFlags });
  },

  clearCelebratedPRs: () => set({ lastCelebratedPRs: null }),

  currentPRFor: (exerciseId) => currentPR(get().exercisePRs, exerciseId),

  prHistoryFor: (exerciseId) =>
    get()
      .exercisePRs.filter((p) => p.exerciseId === exerciseId)
      .sort((a, b) => a.date.localeCompare(b.date)),

  prsForSession: (sessionId) => get().exercisePRs.filter((p) => p.sessionId === sessionId),

  getSetsForExercise: (exerciseId) =>
    get().sessionLogs.flatMap((l) => l.sets.filter((s) => s.exerciseId === exerciseId)),

  getLastSessionLog: (sessionTemplateId) =>
    get().sessionLogs
      .filter((l) => l.sessionTemplateId === sessionTemplateId)
      .sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime())[0] ?? null,
}));
