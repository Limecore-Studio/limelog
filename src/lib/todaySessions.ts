// limelog#43: Today lists the ACTIVE phase's sessions for the weekday.
//
// Every SessionTemplate belongs to exactly one phase (`phaseId` is required,
// and PhaseList groups by it), so a block with a Saturday Push in both
// Accumulation and Intensification has two Saturday sessions. Today used to
// filter on the weekday alone and listed both, which offers the wrong
// phase's prescription a tap away from "Start".
import type { Phase, Program, SessionTemplate } from '@/types/program';
import type { SessionLog } from '@/types/logging';

/**
 * The phase the program is in, and the one after it, by orderIndex:
 * `activePhaseId` when it names one of the program's phases, else the first.
 *
 * v1.18.1 (LimeLog#73): one rule for Today, the reminders and advancePhase.
 * Today already fell back to the first phase for an activePhaseId naming no
 * phase (which deletePhase used to leave behind) and offered "Next phase",
 * while advancePhase refused to move from it, so the button did nothing.
 */
export function resolvePhase(
  program: Pick<Program, 'phases' | 'activePhaseId'> | null | undefined,
): { current: Phase | null; next: Phase | null } {
  if (!program || program.phases.length === 0) return { current: null, next: null };
  const sorted = [...program.phases].sort((a, b) => a.orderIndex - b.orderIndex);
  const idx = Math.max(0, sorted.findIndex((ph) => ph.id === program.activePhaseId));
  return { current: sorted[idx], next: sorted[idx + 1] ?? null };
}

/**
 * The sessions the current phase trains, with the fallback described on
 * sessionsForDay. v1.18.1 (LimeLog#73): the reminders are scheduled from this,
 * so they fire on the days Today offers a session, under that session's name.
 */
export function phaseSessions(
  program: (Pick<Program, 'sessions'> & Partial<Pick<Program, 'phases'>>) | null | undefined,
  currentPhaseId: string | null | undefined,
): SessionTemplate[] {
  if (!program) return [];
  // A session whose phase was deleted is kept only so History can name its
  // workouts (deletePhase); it is never offered or reminded about.
  const phaseIds = program.phases?.length ? new Set(program.phases.map((ph) => ph.id)) : null;
  const live = phaseIds ? program.sessions.filter((s) => phaseIds.has(s.phaseId)) : program.sessions;
  if (!currentPhaseId) return live;
  const mine = live.filter((s) => s.phaseId === currentPhaseId);
  return mine.length > 0 ? mine : live;
}

/**
 * Sessions to offer on `dayOfWeek`. `currentPhaseId` is the phase Today already
 * resolves (activePhaseId, else the lowest orderIndex).
 *
 * One deliberate fallback: if the current phase has no sessions on ANY day,
 * every phase's sessions for the weekday are offered, as before. That only
 * happens when a program was set up with its work in a later phase that was
 * never advanced to, and an empty Today would hide a workout the user built.
 */
export function sessionsForDay(
  program: (Pick<Program, 'sessions'> & Partial<Pick<Program, 'phases'>>) | null | undefined,
  dayOfWeek: number,
  currentPhaseId: string | null | undefined,
): SessionTemplate[] {
  return phaseSessions(program, currentPhaseId).filter((s) => s.dayOfWeek === dayOfWeek);
}

/**
 * The rep target each set of a finished workout was prescribed, for the deload
 * heuristic (missedRepRatio).
 *
 * v1.18.1 (LimeLog#73): the workout's own session template first. Targets used
 * to come from whichever session in ANY phase listed the exercise first, so an
 * Intensification squat at 3–5 was judged against Accumulation's 8–12, every
 * set "fell short", and the deload banner showed every Intensification week.
 * A workout whose template is gone falls back to the current phase's sessions.
 */
export function deloadTargetReps(
  program: Pick<Program, 'sessions'> | null | undefined,
  currentPhaseId: string | null | undefined,
): (log: Pick<SessionLog, 'sessionTemplateId' | 'exerciseSwaps'>, exerciseId: string) => string | undefined {
  const fallback = new Map<string, string>();
  for (const session of phaseSessions(program, currentPhaseId)) {
    for (const se of session.exercises) {
      if (!fallback.has(se.exerciseId)) fallback.set(se.exerciseId, se.targetReps);
    }
  }
  return (log, exerciseId) => {
    const own = program?.sessions.find((s) => s.id === log.sessionTemplateId);
    // A swapped slot's sets carry the substitute's id (lib/exerciseSwap.ts,
    // which is not imported here: it would pull the swap sheet's search code
    // into the startup chunk).
    const se = own?.exercises.find((x) => (log.exerciseSwaps?.[x.id] ?? x.exerciseId) === exerciseId);
    return se?.targetReps ?? fallback.get(exerciseId);
  };
}

export function isSameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** The log a session card on Today shows: that session's, started today. */
export function todaysLog(logs: SessionLog[], sessionId: string, now: Date): SessionLog | undefined {
  return logs.find((l) => l.sessionTemplateId === sessionId && isSameLocalDay(l.loggedAt, now));
}

/**
 * Unfinished workouts that none of Today's session cards shows, newest first.
 *
 * v1.18.1 (LimeLog#74): a card only shows a log of one of TODAY's sessions
 * started TODAY, and Today is the only way into a workout. One begun at 23:50
 * dropped off at midnight, so it could not be finished, was never pushed and
 * never reached History. Cardio is logged already finished and never appears.
 *
 * Only the last week's, and one with no set done only for a day: these used
 * to vanish at midnight, so every Start tapped by mistake would otherwise sit
 * on Today for good.
 */
const RESUME_WINDOW_MS = 7 * 24 * 3600 * 1000;
const EMPTY_LOG_WINDOW_MS = 24 * 3600 * 1000;

export function resumableLogs(logs: SessionLog[], todaySessions: SessionTemplate[], now: Date): SessionLog[] {
  const onCards = new Set(todaySessions.map((s) => todaysLog(logs, s.id, now)?.id));
  const age = (l: SessionLog) => now.getTime() - new Date(l.loggedAt).getTime();
  return logs
    .filter((l) => !l.finalizedAt && !l.activityType && !onCards.has(l.id))
    .filter((l) => age(l) <= RESUME_WINDOW_MS && (age(l) <= EMPTY_LOG_WINDOW_MS || l.sets.some((s) => s.completed)))
    .sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime());
}
